/**
 * Frame source for a Miniscope recording folder: `0.avi, 1.avi, ...` plus the
 * optional `metaData.json` and `timeStamps.csv`.
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
import { naturalCompare } from './natural-sort.ts';
import {
  fpsFromTimeStamps,
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

export type FpsSourceKind = 'timestamps' | 'metadata' | 'none';

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
}

/** A recording folder's files after picking the Miniscope directory. */
interface Group {
  dir: string;
  avis: { file: File; index: number }[];
  /** Gaps or duplicate numbers among the N.avi names. */
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

const AVI_NAME = /^(\d+)\.avi$/i;
// Miniscope writes metaData.json and timeStamps.csv. Exported datasets often
// prefix them (neural_metaData.json, neural_timestamp.csv), so a prefixed name
// is accepted too; see pickSidecar.
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

function dirOf(relPath: string): string {
  const slash = relPath.lastIndexOf('/');
  return slash < 0 ? '' : relPath.slice(0, slash);
}

/** Warnings for N.avi numbering that is not 0, 1, 2, ... without repeats. */
function numberingWarnings(avis: { file: File; index: number }[]): string[] {
  const out: string[] = [];
  const seen = new Map<number, string>();
  for (const { file, index } of avis) {
    const prior = seen.get(index);
    if (prior !== undefined) {
      out.push(`${prior} and ${file.name} have the same number; both are used.`);
    }
    seen.set(index, file.name);
  }
  const unique = [...seen.keys()].sort((a, b) => a - b);
  if (unique.length > 0 && unique[0] !== 0) {
    out.push(`The numbering starts at ${unique[0]}.avi, not 0.avi.`);
  }
  const missing: number[] = [];
  for (let i = 1; i < unique.length; i++) {
    for (let k = unique[i - 1] + 1; k < unique[i] && missing.length < 20; k++) missing.push(k);
  }
  if (missing.length > 0) {
    out.push(`Missing ${missing.map((k) => `${k}.avi`).join(', ')} in the numbering.`);
  }
  return out;
}

function groupFiles(entries: FolderEntry[]): {
  group: Group;
  metaData?: File;
  timeStamps?: File;
  ignored: string[];
} {
  const byDir = new Map<string, Group>();
  const get = (dir: string): Group => {
    let g = byDir.get(dir);
    if (!g) {
      g = { dir, avis: [], numberingWarnings: [], sidecars: [] };
      byDir.set(dir, g);
    }
    return g;
  };
  for (const { file, relPath } of entries) {
    const dir = dirOf(relPath);
    const m = AVI_NAME.exec(file.name);
    if (m) get(dir).avis.push({ file, index: Number(m[1]) });
    else if (METADATA_NAME.test(file.name) || TIMESTAMPS_NAME.test(file.name)) {
      get(dir).sidecars.push(file);
    }
  }
  const candidates = [...byDir.values()].filter((g) => g.avis.length > 0);
  if (candidates.length === 0) {
    throw new Error(
      'No Miniscope video found: expected files named 0.avi, 1.avi, ... (select the folder that contains them).',
    );
  }
  // A parent folder can hold several devices (Miniscope, behaviour camera).
  // Prefer a directory that looks like the miniscope, then the one with the most files.
  const score = (g: Group) =>
    (/miniscope/i.test(g.dir) ? 1_000_000 : 0) + g.avis.length - (g.dir.split('/').length - 1);
  candidates.sort((a, b) => score(b) - score(a));
  const group = candidates[0];
  const metaData = pickSidecar(group.sidecars, METADATA_NAME, /^metadata\.json$/i);
  const timeStamps = pickSidecar(group.sidecars, TIMESTAMPS_NAME, /^timestamps\.csv$/i);
  group.avis.sort((a, b) => a.index - b.index || naturalCompare(a.file.name, b.file.name));
  const used = new Set<File>(group.avis.map((a) => a.file));
  group.numberingWarnings = numberingWarnings(group.avis);
  const ignored = entries
    .filter((e) => !used.has(e.file) && e.file !== metaData && e.file !== timeStamps)
    .map((e) => e.relPath);
  return { group, metaData, timeStamps, ignored };
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

export class FrameSource {
  private readonly avis: OpenedAvi[];
  readonly info: FrameSourceInfo;

  // Explicit fields rather than parameter properties, so the file also runs
  // under Node's type stripping (apps/cala/scripts/real-data-check.mjs).
  private constructor(avis: OpenedAvi[], info: FrameSourceInfo) {
    this.avis = avis;
    this.info = info;
  }

  /** Open a Miniscope folder given as the flat list of its files (see `entriesFromFiles`). */
  static async open(entries: FolderEntry[]): Promise<FrameSource> {
    const { group, metaData, timeStamps, ignored } = groupFiles(withNames(entries));
    const warnings: string[] = [...group.numberingWarnings];

    const all = await Promise.all(
      group.avis.map(async ({ file }) => ({ file, header: await openAvi(file) })),
    );
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

    let start = 0;
    const avis: OpenedAvi[] = opened.map(({ file, header }) => {
      const a = { name: file.name, file, header, start };
      start += header.frameCount;
      return a;
    });

    const meta: MiniscopeMetadata | null = parseMetadataText(await readText(metaData));
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
      warnings.push('No frame rate found (no usable timeStamps.csv or metaData.json).');
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

    let done = 0;
    while (done < count) {
      const { avi, local } = this.locate(start + done);
      const want = Math.min(count - done, avi.header.frameCount - local, MAX_FRAMES_PER_READ);
      const run = avi.header.contiguousRun(local, want);
      if (run === 0) throw new Error(`${avi.name}: no frame at ${local}.`);
      try {
        const [from, to] = avi.header.spanByteRange(local, run);
        const span = await readBytes(avi.file, from, to);
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
