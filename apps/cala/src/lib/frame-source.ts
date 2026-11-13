/**
 * Frame source for a Miniscope recording folder: a numbered series of `.avi`
 * files (`0.avi, 1.avi, ...` or `msCam0.avi, msCam1.avi, ...`, optionally
 * zero-padded; see `video-series.ts`) plus the optional `metaData.json` and
 * `timeStamps.csv` in the same directory.
 *
 * Nothing here reads a whole video file. Per file it reads a byte prefix (the
 * AVI header) and the `idx1` region that follows the `movi` list, then parses
 * both with the wasm `AviHeader`; `readFrame` / `readFrames` later slice just
 * the frames asked for out of the owning `File`.
 *
 * Intended reuse: this module imports nothing from the UI, only the wasm
 * adapter and pure helpers, so it is meant to move into a package and be
 * driven by the streaming-processing worker, which reads sequentially at high
 * throughput with `readFrames(start, count, out)` into buffers it owns
 * (reusing them between calls, or transferring them on). It lives in the app
 * for now because only cala uses it and it depends on the cala WASM module,
 * which `@calab/core` must not import.
 */
import { AviHeader, aviIdx1PayloadLen, aviIsAvixContinuation } from './cala-wasm.ts';
import type { DeviceIdentity } from './flat-field.ts';
import { chooseSeries, detectSeries, dirOf, looseAvis, numberingWarnings } from './video-series.ts';
import {
  ASSUMED_FPS,
  fpsFromTimeStamps,
  parseDeviceIdentity,
  parseMetadata,
  parseTimeStamps,
  type MiniscopeMetadata,
} from './miniscope-meta.ts';

/** First read of each file. The Miniscope header is a few KB; JUNK padding fits too. */
export const HEADER_PREFIX_BYTES = 64 * 1024;
/** Cap on a header prefix retry, so a corrupt file cannot make us read megabytes. */
const MAX_HEADER_PREFIX_BYTES = 8 * 1024 * 1024;
/** Relative frame-rate disagreement (timestamps vs metadata) that earns a warning. */
const FPS_MISMATCH_TOLERANCE = 0.05;
/**
 * Most frames fetched with one `File.slice`. The span is copied into wasm
 * memory to decode, so this bounds peak memory to about twice the span
 * (64 x 600x600 frames = 23 MB).
 */
export const MAX_FRAMES_PER_READ = 64;
/** Header reads in flight while opening a folder (a multi-day recording has thousands of files). */
export const OPEN_CONCURRENCY = 16;
/** Read spans kept in flight: the one being decoded and the next. */
export const READ_AHEAD_SPANS = 2;
/** Spans larger than this are not read ahead of the call that needs them, bytes. */
const MAX_PREFETCH_BYTES = 64 * 1048576;

/** Decoded pixels: one element per pixel, `Uint16Array` for 16-bit video. */
export type FramePixels = Uint8Array | Uint16Array;

/**
 * A selected file with its path inside the picked or dropped folder. The path
 * travels as data (not as a `webkitRelativePath` property, which structured
 * clone drops when the files are posted to a worker).
 */
export interface FolderEntry {
  file: File;
  /** Path relative to the selection root, `/`-separated; a bare name for loose files. */
  relPath: string;
}

/**
 * Entries whose File objects carry the name from `relPath`. Browsers keep a
 * File intact through postMessage, but some runtimes (Node 22's
 * structuredClone) hand back a nameless Blob; the name in the entry is the
 * authority, and wrapping the Blob in a File is lazy (no bytes are copied).
 */
function withNames(entries: FolderEntry[]): FolderEntry[] {
  return entries.map(({ file, relPath }) => {
    const name = relPath.slice(relPath.lastIndexOf('/') + 1);
    return { file: file.name === name ? file : new File([file], name), relPath };
  });
}

/** Entries for a `webkitdirectory` input or a plain file list, read on the main thread. */
export function entriesFromFiles(files: File[]): FolderEntry[] {
  return files.map((file) => ({
    file,
    relPath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
  }));
}

export interface FrameSourceFileInfo {
  name: string;
  frames: number;
}

export type FpsSourceKind = 'timestamps' | 'metadata' | 'none' | 'live';

/** Plain, structured-cloneable description of an opened recording. */
export interface FrameSourceInfo {
  frameCount: number;
  width: number;
  height: number;
  /** 8 or 16. 16-bit frames come back as little-endian byte pairs. */
  bitDepth: number;
  fourcc: string;
  /** The DIB stores rows bottom-up (reported only; frames are returned as stored). */
  bottomUp: boolean;
  /** Frame rate in Hz from timestamps or metadata; null when neither exists. */
  fps: number | null;
  fpsSource: FpsSourceKind;
  fpsFromMetadata: number | null;
  fpsFromTimestamps: number | null;
  /** The AVI header's frame rate. Shown for diagnostics only; never used. */
  aviDeclaredFps: number | null;
  /** Rows in timeStamps.csv, if the file was present. */
  timestampCount: number | null;
  files: FrameSourceFileInfo[];
  /** Files in the selection that were not used (other folders, other names). */
  ignoredFiles: string[];
  warnings: string[];
  /** A live stream (`lib/live-source.ts`): `frameCount` is unbounded and frames cannot be re-read. */
  live?: { url: string; name?: string };
  /** What `metaData.json` (or a live hello) says about the sensor; see `flatFieldKey`. */
  device?: DeviceIdentity;
  /** Sessions opened as one recording (`openSessions`), in order. Absent for a plain folder. */
  sessions?: SessionSpan[];
}

/** One session of a multi-session run, as handed to `FrameSource.openSessions`. */
export interface SessionInput {
  /** Display name (the session folder relative to the picked one). */
  name: string;
  /** The session's folder, relative to the selection root. */
  dir: string;
  /** Its video series and the sidecars next to it. */
  entries: FolderEntry[];
}

/** Where one session's frames are in a multi-session recording. */
export interface SessionSpan {
  /** 0-based position in the run. */
  index: number;
  name: string;
  dir: string;
  /** Global index of its first frame. */
  startFrame: number;
  frameCount: number;
  /** Its own frame rate (the recording uses the first session's). */
  fps: number | null;
  files: number;
}

/** First frames of sessions 1..n-1 (where a new session starts); empty for one session. */
export function sessionBoundaries(info: Pick<FrameSourceInfo, 'sessions'>): number[] {
  return (info.sessions ?? []).slice(1).map((s) => s.startFrame);
}

/** The session holding global frame `frame` (0 when there are no sessions). */
export function sessionOfFrame(info: Pick<FrameSourceInfo, 'sessions'>, frame: number): number {
  const spans = info.sessions ?? [];
  let k = 0;
  for (let i = 1; i < spans.length; i++) if (spans[i].startFrame <= frame) k = i;
  return k;
}

/** The files of the chosen video series, plus the sidecars next to it. */
interface Group {
  dir: string;
  avis: { file: File; index: number }[];
  /** Gaps or duplicate numbers among the numbered names. */
  numberingWarnings: string[];
  /** Files that might be metaData.json / timeStamps.csv (picked after the folder is chosen). */
  sidecars: File[];
}

interface OpenedAvi {
  name: string;
  file: File;
  header: AviHeader;
  start: number; // global index of this file's first frame
}

// Miniscope writes metaData.json and timeStamps.csv. Exported datasets often
// prefix them (neural_metaData.json, neural_timestamp.csv), so a prefixed name
// is accepted too; see pickSidecar.
/** Shown when the selection holds no numbered `.avi` series. */
export const NO_VIDEO_MESSAGE =
  'No Miniscope video found: expected numbered .avi files such as 0.avi, 1.avi ... or msCam0.avi, msCam1.avi ... (select the folder that contains them, or use "Choose individual files").';

const METADATA_NAME = /(?:^|[_-])metadata\.json$/i;
const TIMESTAMPS_NAME = /(?:^|[_-])time_?stamps?\.csv$/i;
const NEURAL_PREFIX = /^(?:neural|miniscope|ms)[_-]/i;

/**
 * The sidecar file of one kind: the exact Miniscope name if present, else a
 * single prefixed copy (preferring a neural/miniscope prefix over, say,
 * behavior_). Ambiguous prefixed copies are ignored rather than guessed.
 */
function pickSidecar(files: File[], pattern: RegExp, exactName: RegExp): File | undefined {
  const exact = files.find((f) => exactName.test(f.name));
  if (exact) return exact;
  const prefixed = files.filter((f) => pattern.test(f.name));
  const neural = prefixed.filter((f) => NEURAL_PREFIX.test(f.name));
  if (neural.length === 1) return neural[0];
  return prefixed.length === 1 ? prefixed[0] : undefined;
}

function groupFiles(entries: FolderEntry[]): {
  group: Group;
  metaData?: File;
  timeStamps?: File;
  ignored: string[];
} {
  // The video series: the clear choice, else the best-ranked one (the app asks
  // the user first when it is ambiguous, see `lib/video-series.ts`). Files
  // picked one by one that are not numbered are used in natural order.
  const { chosen, candidates } = chooseSeries(detectSeries(entries));
  const series = chosen ?? candidates[0];
  let dir: string;
  let avis: { file: File; index: number }[];
  let warnings: string[];
  if (series) {
    dir = series.dir;
    avis = series.files.map((f) => ({ file: f.entry.file, index: f.index }));
    warnings = numberingWarnings(series);
  } else {
    const loose = looseAvis(entries);
    if (loose.length === 0) throw new Error(NO_VIDEO_MESSAGE);
    dir = '';
    avis = loose.map((e, index) => ({ file: e.file, index }));
    warnings = [];
  }
  const sidecars = entries
    .filter(
      (e) =>
        dirOf(e.relPath) === dir &&
        (METADATA_NAME.test(e.file.name) || TIMESTAMPS_NAME.test(e.file.name)),
    )
    .map((e) => e.file);
  const group: Group = { dir, avis, numberingWarnings: warnings, sidecars };
  const metaData = pickSidecar(sidecars, METADATA_NAME, /^metadata\.json$/i);
  const timeStamps = pickSidecar(sidecars, TIMESTAMPS_NAME, /^timestamps\.csv$/i);
  const used = new Set<File>(avis.map((a) => a.file));
  const ignored = entries
    .filter((e) => !used.has(e.file) && e.file !== metaData && e.file !== timeStamps)
    .map((e) => e.relPath);
  return { group, metaData, timeStamps, ignored };
}

/**
 * `fn` over `items` with at most `limit` running at once, results in order.
 * Stops starting new work after the first failure and rethrows it.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i], i);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function readBytes(file: File, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

/** Parse one AVI file from a prefix and its idx1 region, never reading it whole. */
async function openAvi(file: File): Promise<AviHeader> {
  let prefix = await readBytes(file, 0, Math.min(file.size, HEADER_PREFIX_BYTES));
  let layout: Float64Array;
  for (;;) {
    try {
      layout = AviHeader.layout(prefix);
      break;
    } catch (err) {
      const needed = AviHeader.neededBytes(prefix);
      const canGrow =
        needed > prefix.length && prefix.length < file.size && needed <= MAX_HEADER_PREFIX_BYTES;
      if (!canGrow) throw withFile(file, err);
      prefix = await readBytes(file, 0, Math.min(file.size, needed));
    }
  }
  const [riffEnd, moviEnd] = layout;

  // OpenDML files continue in further RIFF chunks; not supported (yet).
  if (file.size >= riffEnd + 12) {
    const next = await readBytes(file, riffEnd, riffEnd + 12);
    if (aviIsAvixContinuation(next)) {
      throw withFile(file, new Error('OpenDML AVI (AVIX continuation) is not supported.'));
    }
  }

  // idx1 follows the movi list and, when present and whole, decides the frame
  // offsets. A missing, unknown-position or cut-short one leaves the fixed
  // stride (bounded by the file size) in charge.
  let idx1: Uint8Array | null = null;
  if (moviEnd > 0 && file.size >= moviEnd + 8) {
    let payloadLen: number | null;
    try {
      payloadLen = aviIdx1PayloadLen(await readBytes(file, moviEnd, moviEnd + 8));
    } catch {
      payloadLen = null;
    }
    if (payloadLen !== null && moviEnd + 8 + payloadLen <= file.size) {
      idx1 = await readBytes(file, moviEnd + 8, moviEnd + 8 + payloadLen);
    }
  }
  try {
    return AviHeader.parse(prefix, idx1, file.size);
  } catch (err) {
    throw withFile(file, err);
  }
}

function withFile(file: File, err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  return new Error(`${file.name}: ${msg}`);
}

async function readText(file: File | undefined): Promise<string | null> {
  if (!file) return null;
  try {
    return await file.text();
  } catch {
    return null;
  }
}

/** One recording's files opened: the headers of its non-empty videos, in order, and its info. */
interface OpenedRecording {
  opened: { file: File; header: AviHeader }[];
  info: FrameSourceInfo;
}

/** Open the headers and sidecars of one recording (one video series). */
async function openRecording(
  entries: FolderEntry[],
  onProgress?: (opened: number, total: number) => void,
): Promise<OpenedRecording> {
  const { group, metaData, timeStamps, ignored } = groupFiles(withNames(entries));
  const warnings: string[] = [...group.numberingWarnings];

  // Header reads are throttled: ~7.8k files for a three-day recording, and
  // each is a few small reads that a network drive answers slowly.
  let opening = 0;
  const all = await mapLimit(group.avis, OPEN_CONCURRENCY, async ({ file }) => {
    const header = await openAvi(file);
    onProgress?.(++opening, group.avis.length);
    return { file, header };
  });
  // A file with no complete frame (a crash right after it was created) is
  // dropped with a warning instead of failing the whole recording.
  const opened = all.filter((o) => o.header.frameCount > 0);
  for (const o of all) {
    if (o.header.frameCount === 0) {
      warnings.push(`${o.file.name} has no complete frames and was skipped.`);
      o.header.free();
    }
  }
  if (opened.length === 0) throw new Error('The video files contain no frames.');
  const first = opened[0].header;
  const geometry = (h: AviHeader) => `${h.width}x${h.height} ${h.bitDepth}-bit`;
  for (const { file, header } of opened) {
    if (
      header.width !== first.width ||
      header.height !== first.height ||
      header.bitDepth !== first.bitDepth
    ) {
      const message = `${file.name} is ${geometry(header)} but ${opened[0].file.name} is ${geometry(first)}; all files must match.`;
      for (const o of opened) o.header.free();
      throw new Error(message);
    }
  }

  const avis = opened.map(({ file, header }) => ({ name: file.name, header }));
  const start = avis.reduce((a, x) => a + x.header.frameCount, 0);

  const metaText = await readText(metaData);
  const meta: MiniscopeMetadata | null = parseMetadataText(metaText);
  const device = metaText === null ? null : parseDeviceIdentity(metaText);
  const stamps = parseTimeStampsText(await readText(timeStamps));
  const fpsMeta = meta?.frameRate ?? null;
  const fpsStamps = stamps ? fpsFromTimeStamps(stamps.ms) : null;

  // Measured beats nominal: timestamps first, then metadata. Never the AVI header.
  let fps: number | null = null;
  let fpsSource: FpsSourceKind = 'none';
  if (fpsStamps !== null) {
    fps = fpsStamps;
    fpsSource = 'timestamps';
  } else if (fpsMeta !== null) {
    fps = fpsMeta;
    fpsSource = 'metadata';
  }
  if (
    fpsStamps !== null &&
    fpsMeta !== null &&
    Math.abs(fpsStamps - fpsMeta) / fpsMeta > FPS_MISMATCH_TOLERANCE
  ) {
    warnings.push(
      `Timestamps give ${fpsStamps.toFixed(2)} Hz but metaData.json says ${fpsMeta} Hz; using the timestamps.`,
    );
  }
  if (stamps && stamps.ms.length !== start) {
    warnings.push(
      `timeStamps.csv has ${stamps.ms.length} rows but the videos have ${start} frames.`,
    );
  }
  if (fps === null) {
    warnings.push(
      `No frame rate found (no usable timeStamps.csv or metaData.json); time-based settings (QC windows, background, flat field) assume ${ASSUMED_FPS} Hz.`,
    );
  }
  for (const a of avis) {
    if (a.header.skippedEmptyFrames > 0) {
      warnings.push(
        `${a.name}: ${a.header.skippedEmptyFrames} dropped-frame index entries were skipped, so later frames shift against the timestamps.`,
      );
    }
  }
  for (const a of avis) {
    if (a.header.hasIdx1 === false) {
      warnings.push(`${a.name} has no idx1 index; frame offsets assume a fixed stride.`);
      break;
    }
  }

  const declaredUsec = first.declaredUsecPerFrame;
  const info: FrameSourceInfo = {
    frameCount: start,
    width: first.width,
    height: first.height,
    bitDepth: first.bitDepth,
    fourcc: first.fourcc,
    bottomUp: first.bottomUp,
    fps,
    fpsSource,
    fpsFromMetadata: fpsMeta,
    fpsFromTimestamps: fpsStamps,
    aviDeclaredFps: declaredUsec > 0 ? 1e6 / declaredUsec : null,
    timestampCount: stamps ? stamps.ms.length : null,
    files: avis.map((a) => ({ name: a.name, frames: a.header.frameCount })),
    ignoredFiles: ignored,
    warnings,
    ...(device ? { device } : {}),
  };
  return { opened, info };
}

/** One file read: `run` frames of `avi` at bytes [from, to). */
interface Span {
  avi: OpenedAvi;
  run: number;
  from: number;
  to: number;
}

export class FrameSource {
  private readonly avis: OpenedAvi[];
  /** Reads started ahead of the call that will want them, by span. */
  private readonly ahead = new Map<string, Promise<Uint8Array>>();
  /** End frame of the last `readFrames` call (to spot sequential reading). */
  private lastEnd = -1;
  readonly info: FrameSourceInfo;

  // Explicit fields rather than parameter properties, so the file also runs
  // under Node's type stripping (apps/cala/scripts/real-data-check.mjs).
  private constructor(avis: OpenedAvi[], info: FrameSourceInfo) {
    this.avis = avis;
    this.info = info;
  }

  /** Open a Miniscope folder given as the flat list of its files (see `entriesFromFiles`). */
  static async open(
    entries: FolderEntry[],
    options: { onProgress?: (opened: number, total: number) => void } = {},
  ): Promise<FrameSource> {
    const r = await openRecording(entries, options.onProgress);
    let start = 0;
    const avis: OpenedAvi[] = r.opened.map(({ file, header }) => {
      const a = { name: file.name, file, header, start };
      start += header.frameCount;
      return a;
    });
    return new FrameSource(avis, r.info);
  }

  /**
   * Open several sessions as one recording, in the order given (a Joint run,
   * see `docs/stages.md`): their frames follow one another and
   * `info.sessions` says where each starts. Every session must have the
   * first one's width, height and bit depth. The frame rate is the first
   * session's (a differing rate is a warning when the sessions are listed,
   * see `validateSessions`). One session opens exactly as `open` does, plus
   * `info.sessions`.
   */
  static async openSessions(
    sessions: readonly SessionInput[],
    options: { onProgress?: (opened: number, total: number) => void } = {},
  ): Promise<FrameSource> {
    if (sessions.length === 0) throw new Error('No sessions to open.');
    const opened: { session: SessionInput; r: OpenedRecording }[] = [];
    const total = sessions.reduce((a, s) => a + s.entries.length, 0);
    let done = 0;
    try {
      for (const session of sessions) {
        const r = await openRecording(session.entries, () => options.onProgress?.(++done, total));
        opened.push({ session, r });
      }
    } catch (err) {
      for (const o of opened) for (const a of o.r.opened) a.header.free();
      throw err instanceof Error && sessions.length > 1
        ? new Error(`${sessions[opened.length]?.name ?? 'session'}: ${err.message}`)
        : err;
    }
    const first = opened[0].r.info;
    const geometry = (i: FrameSourceInfo) => `${i.width}x${i.height} ${i.bitDepth}-bit`;
    for (const { session, r } of opened) {
      const i = r.info;
      if (i.width !== first.width || i.height !== first.height || i.bitDepth !== first.bitDepth) {
        for (const o of opened) for (const a of o.r.opened) a.header.free();
        throw new Error(
          `${session.name} is ${geometry(i)} but ${opened[0].session.name} is ${geometry(first)}; all sessions must match.`,
        );
      }
    }
    const avis: OpenedAvi[] = [];
    const spans: SessionSpan[] = [];
    const warnings: string[] = [];
    let start = 0;
    opened.forEach(({ session, r }, index) => {
      spans.push({
        index,
        name: session.name,
        dir: session.dir,
        startFrame: start,
        frameCount: r.info.frameCount,
        fps: r.info.fps,
        files: r.info.files.length,
      });
      for (const w of r.info.warnings)
        warnings.push(sessions.length > 1 ? `${session.name}: ${w}` : w);
      for (const { file, header } of r.opened) {
        avis.push({ name: file.name, file, header, start });
        start += header.frameCount;
      }
    });
    const info: FrameSourceInfo = {
      ...first,
      frameCount: start,
      timestampCount: opened.every((o) => o.r.info.timestampCount !== null)
        ? opened.reduce((a, o) => a + (o.r.info.timestampCount ?? 0), 0)
        : null,
      files: opened.flatMap((o) => o.r.info.files),
      ignoredFiles: opened.flatMap((o) => o.r.info.ignoredFiles),
      warnings,
      sessions: spans,
    };
    return new FrameSource(avis, info);
  }

  get frameCount(): number {
    return this.info.frameCount;
  }
  get width(): number {
    return this.info.width;
  }
  get height(): number {
    return this.info.height;
  }

  /** Index of the file holding global frame `index`, by binary search on start offsets. */
  private locate(index: number): { avi: OpenedAvi; local: number } {
    let lo = 0;
    let hi = this.avis.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.avis[mid].start <= index) lo = mid;
      else hi = mid - 1;
    }
    const avi = this.avis[lo];
    return { avi, local: index - avi.start };
  }

  /** The file reads that cover frames [start, start + count): contiguous runs, at most MAX_FRAMES_PER_READ each. */
  private plan(start: number, count: number): Span[] {
    const spans: Span[] = [];
    let done = 0;
    while (done < count) {
      const { avi, local } = this.locate(start + done);
      const want = Math.min(count - done, avi.header.frameCount - local, MAX_FRAMES_PER_READ);
      let run: number;
      let range: [number, number];
      try {
        run = avi.header.contiguousRun(local, want);
        if (run === 0) throw new Error(`${avi.name}: no frame at ${local}.`);
        range = avi.header.spanByteRange(local, run) as unknown as [number, number];
      } catch (err) {
        throw withFile(avi.file, err);
      }
      spans.push({ avi, run, from: range[0], to: range[1] });
      done += run;
    }
    return spans;
  }

  /** The bytes of a span: a read-ahead already under way, or a new read. */
  private fetchSpan(span: Span): Promise<Uint8Array> {
    const key = `${span.avi.start}:${span.from}:${span.to}`;
    const ahead = this.ahead.get(key);
    if (ahead) {
      this.ahead.delete(key);
      return ahead;
    }
    return readBytes(span.avi.file, span.from, span.to);
  }

  /**
   * Start reading the first span of the call that will follow (frames from
   * `next`, `count` of them): sequential readers wait on the file system or
   * network for each batch, and this overlaps that wait with decoding and
   * everything downstream. At most one span ahead, and not a huge one.
   */
  private prefetchNext(next: number, count: number): void {
    const n = Math.min(count, this.info.frameCount - next);
    if (n < 1) return;
    let first: Span;
    try {
      first = this.plan(next, Math.min(n, MAX_FRAMES_PER_READ))[0];
    } catch {
      return;
    }
    const key = `${first.avi.start}:${first.from}:${first.to}`;
    if (this.ahead.has(key) || first.to - first.from > MAX_PREFETCH_BYTES) return;
    const p = readBytes(first.avi.file, first.from, first.to);
    p.catch(() => {});
    this.ahead.set(key, p);
    // Bounded: a reader that jumped around leaves at most a couple of stale spans.
    while (this.ahead.size > READ_AHEAD_SPANS) this.ahead.delete(this.ahead.keys().next().value!);
  }

  /**
   * Read and decode `count` consecutive frames starting at global `start`
   * into one buffer of `count * width * height` pixels (`Uint16Array` for
   * 16-bit video, little-endian host assumed), rows in stored order with
   * padding removed. Pass `out` (right length and type) to reuse a buffer.
   *
   * Frames contiguous in a file are fetched with a single `File.slice`
   * (at most `MAX_FRAMES_PER_READ` per slice), split across file boundaries,
   * and decoded by wasm straight into `out`, with no allocation per frame.
   * idx1 gaps fall back to shorter slices.
   */
  async readFrames(start: number, count: number, out?: FramePixels): Promise<FramePixels> {
    const n = this.info.frameCount;
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(count) ||
      count < 1 ||
      start < 0 ||
      start + count > n
    ) {
      throw new RangeError(`Frames ${start}..${start + count} out of range (0..${n - 1}).`);
    }
    const px = this.info.width * this.info.height;
    const sixteen = this.info.bitDepth === 16;
    const total = px * count;
    if (out && (out.length !== total || out instanceof Uint16Array !== sixteen)) {
      throw new TypeError(
        `out must be a ${sixteen ? 'Uint16Array' : 'Uint8Array'} of ${total} elements.`,
      );
    }
    const dst: FramePixels = out ?? (sixteen ? new Uint16Array(total) : new Uint8Array(total));
    const bytes = new Uint8Array(dst.buffer, dst.byteOffset, dst.byteLength);
    const bytesPerFrame = px * (sixteen ? 2 : 1);

    const spans = this.plan(start, count);
    const sequential = start === this.lastEnd;
    this.lastEnd = start + count;
    // Up to READ_AHEAD_SPANS reads in flight: this span's, and the next's.
    const reads: (Promise<Uint8Array> | undefined)[] = new Array(spans.length);
    const kick = (i: number): void => {
      if (i < spans.length && !reads[i]) {
        reads[i] = this.fetchSpan(spans[i]);
        reads[i]!.catch(() => {}); // surfaced when awaited; unused read-aheads stay quiet
      }
    };
    let done = 0;
    for (let i = 0; i < spans.length; i++) {
      for (let k = 0; k < READ_AHEAD_SPANS; k++) kick(i + k);
      const { avi, run } = spans[i];
      if (i === 0 && sequential) this.prefetchNext(start + count, count);
      try {
        const span = await reads[i]!;
        avi.header.decodeSpanInto(
          span,
          run,
          bytes.subarray(done * bytesPerFrame, (done + run) * bytesPerFrame),
        );
      } catch (err) {
        throw withFile(avi.file, err);
      }
      done += run;
    }
    return dst;
  }

  /** One frame: `readFrames(index, 1)`. */
  readFrame(index: number): Promise<FramePixels> {
    return this.readFrames(index, 1);
  }

  /** Release the WASM-side tables. The source is unusable afterwards. */
  dispose(): void {
    this.ahead.clear();
    for (const a of this.avis) a.header.free();
    this.avis.length = 0;
  }
}

function parseMetadataText(text: string | null): MiniscopeMetadata | null {
  return text === null ? null : parseMetadata(text);
}

function parseTimeStampsText(text: string | null) {
  return text === null ? null : parseTimeStamps(text);
}
