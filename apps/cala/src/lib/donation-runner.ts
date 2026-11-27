/**
 * Data donation, end to end (docs/data-donation.md), without the DOM:
 *
 *   1. encode: the donation worker turns the recording into CALARAW1 chunks;
 *      each is stored locally (OPFS) before the worker may run further ahead;
 *   2. create: with every file's exact size known, register the donation
 *      (`createDonation`; the edge function checks the caps);
 *   3. upload: each file with its own presigned PUT, retried on failure;
 *   4. finish: the edge function checks the files; the local copies go.
 *
 * Two steps (encode everything, then create) because the donation's files and
 * their exact sizes must be declared up front, and a chunk's size is only
 * known once it is compressed.
 *
 * Everything outside is injected (the worker, the donation API, the local
 * store), so the tests drive it with fakes. Cancel stops at the next step and
 * withdraws a donation already created. A failed create, upload or finish
 * keeps the local files and can be resumed (`resume`) or dropped (`discard`).
 */
import {
  DONATION_MAX_BYTES,
  DONATION_MAX_CHUNK_BYTES,
  DONATION_MAX_META_BYTES,
  DONATION_MAX_TIMESTAMPS_BYTES,
  type DonationFile,
  type DonationMeta,
  type DonationSharing,
  type PresignedRequest,
} from '@calab/community';
import { calarawChunkName } from '@calab/io';
import type { FrameSourceInfo } from './frame-source.ts';
import type {
  DonationEncodeInput,
  DonationEvent,
  DonationRequest,
} from '../workers/donation-types.ts';

// Caps of the edge function, mirrored in `@calab/community` so the app can
// refuse before anything is uploaded (the edge function stays the authority).
export const MAX_DONATION_BYTES = DONATION_MAX_BYTES;
export const MAX_CHUNK_BYTES = DONATION_MAX_CHUNK_BYTES;
export const MAX_TIMESTAMPS_BYTES = DONATION_MAX_TIMESTAMPS_BYTES;
export const MAX_META_BYTES = DONATION_MAX_META_BYTES;

/** Expected lossless compression ratio of miniscope video (docs/data-donation.md, Codec). */
export const EXPECTED_COMPRESSION = 1.65;
/** Retries of a failed upload (each with a fresh presigned URL) before giving up. */
export const UPLOAD_RETRIES = 3;

/** Expected compressed size of a recording, bytes. */
export function estimateDonationBytes(
  frames: number,
  width: number,
  height: number,
  bytesPerPixel: number,
): number {
  return Math.ceil((frames * width * height * bytesPerPixel) / EXPECTED_COMPRESSION);
}

// ---------------------------------------------------------------------------
// Injected parts
// ---------------------------------------------------------------------------

/** The donation worker as the runner uses it (a `Worker`, or a fake). */
export interface WorkerLike {
  postMessage(msg: DonationRequest, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<DonationEvent>) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
  terminate(): void;
}

/** The donation client calls the runner needs (`@calab/community`). */
export interface DonationApi {
  createDonation(meta: DonationMeta, files: DonationFile[]): Promise<string>;
  donationUploadUrl(donationId: string, name: string): Promise<PresignedRequest>;
  putPresigned(req: PresignedRequest, bytes: Uint8Array): Promise<void>;
  finishDonation(donationId: string): Promise<void>;
  withdrawDonation(donationId: string): Promise<void>;
}

/** Where the encoded files wait for the upload (OPFS in the app). */
export interface DonationStore {
  write(name: string, bytes: Uint8Array): Promise<void>;
  read(name: string): Promise<Uint8Array>;
  /** Delete one file; a missing file is fine. */
  remove(name: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type DonationPhase =
  | { kind: 'idle' }
  | { kind: 'encoding'; frames: number; totalFrames: number; chunks: number; bytes: number }
  | { kind: 'creating'; files: number; bytes: number }
  | {
      kind: 'uploading';
      donationId: string;
      /** 0-based index of the file being sent, of `count`. */
      index: number;
      count: number;
      name: string;
      /** Bytes of the files already sent, of `totalBytes`. */
      sentBytes: number;
      totalBytes: number;
      /** 1 for the first try. */
      attempt: number;
    }
  | { kind: 'finishing'; donationId: string }
  | { kind: 'done'; donationId: string; bytes: number }
  | { kind: 'cancelled' }
  /** `resumable`: the encoded files are kept, `resume` continues where it failed. */
  | { kind: 'error'; message: string; resumable: boolean };

/** What to donate. */
export interface DonationJob {
  /** The donor's metadata (consent included), with the recording's facts filled in. */
  meta: DonationMeta;
  /** The worker's input: the recording and its expected geometry. */
  encode: DonationEncodeInput;
  /** The contents of `timeStamps.csv`, if the recording has one (uploaded as is). */
  timestamps?: Uint8Array;
  /** `meta.json` (see `buildMetaJson`). */
  metaJson: Uint8Array;
}

/** Thrown for a donation the runner refuses before anything is uploaded. */
export class DonationRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DonationRefused';
  }
}

class Cancelled extends Error {
  constructor() {
    super('cancelled');
  }
}

function messageOf(err: unknown): string {
  if (err instanceof DOMException && err.name === 'QuotaExceededError') {
    return 'Not enough browser storage for the encoded recording. Free disk space (or storage for this site) and try again.';
  }
  return err instanceof Error ? err.message : String(err);
}

/** Checks that need nothing but the job: consent, the recording's facts, the estimated size. */
export function checkJob(job: DonationJob): void {
  const m = job.meta;
  const e = job.encode.expect;
  if (!m.rights_attested || !m.protocol_attested) {
    throw new DonationRefused(
      'Confirm that you may share the data and that it was recorded under an approved protocol.',
    );
  }
  if (!m.indicator.trim() || !m.species.trim() || !m.brain_region.trim() || !m.scope.trim()) {
    throw new DonationRefused('Indicator, species, brain region and scope are required.');
  }
  const bpp = e.bitDepth === 16 ? 2 : 1;
  if (
    m.width !== e.width ||
    m.height !== e.height ||
    m.n_frames !== e.frameCount ||
    m.bytes_per_pixel !== bpp
  ) {
    throw new DonationRefused('The metadata does not match the recording.');
  }
  if (!(Number.isFinite(job.encode.fps) && job.encode.fps > 0) || m.fps !== job.encode.fps) {
    throw new DonationRefused('The frame rate must be a positive number.');
  }
  const estimate = estimateDonationBytes(e.frameCount, e.width, e.height, bpp);
  if (estimate > MAX_DONATION_BYTES) {
    throw new DonationRefused(
      `This recording would be about ${formatBytes(estimate)} compressed, above the ${formatBytes(MAX_DONATION_BYTES)} limit per shared recording.`,
    );
  }
  if (job.timestamps && job.timestamps.length > MAX_TIMESTAMPS_BYTES) {
    throw new DonationRefused(
      `timeStamps.csv is larger than ${formatBytes(MAX_TIMESTAMPS_BYTES)}.`,
    );
  }
  if (job.metaJson.length > MAX_META_BYTES) {
    throw new DonationRefused(`meta.json is larger than ${formatBytes(MAX_META_BYTES)}.`);
  }
}

/** "1.2 GB", "340 MB", "12 kB". */
export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} kB`;
}

// ---------------------------------------------------------------------------
// meta.json
// ---------------------------------------------------------------------------

/** The last path segment: no folders ever leave the machine. */
export function baseName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
}

/** `meta.json`: cala version, the source files' base names and the frame source's facts. */
export function buildMetaJson(
  info: FrameSourceInfo,
  calaVersion: string,
  fps: number,
  sharing: DonationSharing,
): Uint8Array {
  const doc = {
    format: 'cala-donation-meta',
    version: 1,
    cala_version: calaVersion,
    sharing,
    source_files: info.files.map((f) => ({ name: baseName(f.name), frames: f.frames })),
    frame_source: {
      width: info.width,
      height: info.height,
      bitDepth: info.bitDepth,
      fps,
      fpsSource: info.fpsSource,
      fpsFromMetadata: info.fpsFromMetadata,
      fpsFromTimestamps: info.fpsFromTimestamps,
      frameCount: info.frameCount,
      fourcc: info.fourcc,
      bottomUp: info.bottomUp,
      timestampCount: info.timestampCount,
      device: info.device ?? null,
      // Where each session starts (names left out: they are folder paths).
      sessions: info.sessions?.map((s) => ({ startFrame: s.startFrame, frameCount: s.frameCount })),
    },
  };
  return new TextEncoder().encode(JSON.stringify(doc, null, 2));
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface DonationRunnerDeps {
  /** A fresh donation worker (one per donation). */
  worker: () => WorkerLike;
  api: DonationApi;
  store: DonationStore;
  onState?: (s: DonationPhase) => void;
  retries?: number;
  /** Wait before retry `attempt` (default: 1 s, 2 s, 4 s ...). */
  sleep?: (ms: number) => Promise<void>;
}

interface Stored {
  files: DonationFile[];
  /** Files in memory (timestamps, meta.json): not written to the store. */
  inline: Map<string, Uint8Array>;
}

export class DonationRunner {
  private readonly deps: DonationRunnerDeps;
  private state: DonationPhase = { kind: 'idle' };
  private worker: WorkerLike | null = null;
  private cancelled = false;
  private running = false;
  private job: DonationJob | null = null;
  private stored: Stored | null = null;
  private donationId: string | null = null;
  /** Files uploaded so far, in order. */
  private sent = 0;

  constructor(deps: DonationRunnerDeps) {
    this.deps = deps;
  }

  phase(): DonationPhase {
    return this.state;
  }

  /** True while a run or resume is under way. */
  busy(): boolean {
    return this.running;
  }

  private set(s: DonationPhase): void {
    this.state = s;
    this.deps.onState?.(s);
  }

  /** Encode, create, upload and finish. Resolves with the final phase (never rejects). */
  async run(job: DonationJob): Promise<DonationPhase> {
    if (this.running) throw new Error('A share is already running.');
    try {
      checkJob(job);
    } catch (err) {
      this.set({ kind: 'error', message: messageOf(err), resumable: false });
      return this.state;
    }
    this.job = job;
    this.stored = null;
    this.donationId = null;
    this.sent = 0;
    this.cancelled = false;
    this.running = true;
    try {
      this.stored = await this.encode(job);
    } catch (err) {
      this.running = false;
      await this.dropLocal();
      if (err instanceof Cancelled || this.cancelled) this.set({ kind: 'cancelled' });
      else this.set({ kind: 'error', message: messageOf(err), resumable: false });
      return this.state;
    }
    this.running = false;
    return this.resume();
  }

  /** After an error with `resumable`: create (if not yet), upload what is left, finish. */
  async resume(): Promise<DonationPhase> {
    const job = this.job;
    const stored = this.stored;
    if (this.running || !job || !stored) return this.state;
    this.running = true;
    this.cancelled = false;
    try {
      await this.upload(job, stored);
      this.running = false;
      const bytes = stored.files.reduce((a, f) => a + f.bytes, 0);
      const id = this.donationId!;
      await this.dropLocal();
      this.set({ kind: 'done', donationId: id, bytes });
    } catch (err) {
      this.running = false;
      if (err instanceof Cancelled || this.cancelled) {
        await this.discard();
        this.set({ kind: 'cancelled' });
      } else if (err instanceof DonationRefused) {
        await this.dropLocal();
        this.set({ kind: 'error', message: err.message, resumable: false });
      } else {
        this.set({ kind: 'error', message: messageOf(err), resumable: true });
      }
    }
    return this.state;
  }

  /** Stop at the next step; a donation already created is withdrawn. */
  cancel(): void {
    this.cancelled = true;
    this.worker?.postMessage({ type: 'cancel' });
  }

  /** Drop a failed donation: withdraw it if created, delete the local files. */
  async discard(): Promise<void> {
    const id = this.donationId;
    this.donationId = null;
    if (id) {
      try {
        await this.deps.api.withdrawDonation(id);
      } catch {
        // It stays in "My donations", where it can be withdrawn by hand.
      }
    }
    await this.dropLocal();
    if (this.state.kind === 'error') this.set({ kind: 'idle' });
  }

  private async dropLocal(): Promise<void> {
    const stored = this.stored;
    this.stored = null;
    if (!stored) return;
    for (const f of stored.files) {
      if (stored.inline.has(f.name)) continue;
      try {
        await this.deps.store.remove(f.name);
      } catch {
        // best effort; the app sweeps unowned OPFS files later
      }
    }
  }

  // ---- encode ----

  private encode(job: DonationJob): Promise<Stored> {
    const total = job.encode.expect.frameCount;
    const files: DonationFile[] = [];
    // Partly written chunks are tracked here so a failure can delete them.
    this.stored = { files, inline: new Map() };
    let bytes = 0;
    let frames = 0;
    this.set({ kind: 'encoding', frames: 0, totalFrames: total, chunks: 0, bytes: 0 });
    return new Promise<Stored>((resolve, reject) => {
      const worker = this.deps.worker();
      this.worker = worker;
      let writes: Promise<void> = Promise.resolve();
      let settled = false;
      const finish = (err: unknown, value?: Stored): void => {
        if (settled) return;
        settled = true;
        this.worker = null;
        worker.onmessage = null;
        worker.onerror = null;
        worker.terminate();
        if (!err) resolve(value!);
        // A failure waits for the write under way, so the cleanup that follows sees every file.
        else
          void writes.then(
            () => reject(err),
            () => reject(err),
          );
      };
      const fail = (err: unknown): void => {
        worker.postMessage({ type: 'cancel' });
        finish(err);
      };
      const progress = (): void =>
        this.set({ kind: 'encoding', frames, totalFrames: total, chunks: files.length, bytes });
      worker.onerror = (e) => finish(new Error(e.message || 'The sharing worker failed.'));
      worker.onmessage = (e) => {
        const msg = e.data;
        switch (msg.type) {
          case 'progress':
            frames = msg.frames;
            progress();
            return;
          case 'chunk': {
            const name = calarawChunkName(msg.index);
            const size = msg.bytes.length;
            if (size > MAX_CHUNK_BYTES) {
              fail(new DonationRefused(`${name} is ${formatBytes(size)}, above the chunk limit.`));
              return;
            }
            bytes += size;
            if (bytes > MAX_DONATION_BYTES) {
              fail(
                new DonationRefused(
                  `The compressed recording is larger than the ${formatBytes(MAX_DONATION_BYTES)} limit per shared recording.`,
                ),
              );
              return;
            }
            const index = msg.index;
            writes = writes.then(async () => {
              if (settled) return;
              files.push({ name, bytes: size });
              await this.deps.store.write(name, msg.bytes);
              worker.postMessage({ type: 'ack', index });
              progress();
            });
            writes.catch((err: unknown) => fail(err));
            return;
          }
          case 'done':
            void writes.then(
              () => {
                if (this.cancelled) return fail(new Cancelled());
                if (files.length !== msg.chunks) {
                  return fail(
                    new Error(`Got ${files.length} chunks, the encoder made ${msg.chunks}.`),
                  );
                }
                const inline = new Map<string, Uint8Array>();
                if (job.timestamps) inline.set('timestamps.csv', job.timestamps);
                inline.set('meta.json', job.metaJson);
                for (const [name, b] of inline) files.push({ name, bytes: b.length });
                finish(null, { files, inline });
              },
              (err: unknown) => fail(err),
            );
            return;
          case 'cancelled':
            finish(new Cancelled());
            return;
          case 'error':
            finish(new Error(msg.message));
            return;
        }
      };
      worker.postMessage({ type: 'start', input: job.encode });
      if (this.cancelled) worker.postMessage({ type: 'cancel' });
    });
  }

  // ---- create, upload, finish ----

  private async upload(job: DonationJob, stored: Stored): Promise<void> {
    const { api } = this.deps;
    const totalBytes = stored.files.reduce((a, f) => a + f.bytes, 0);
    if (totalBytes > MAX_DONATION_BYTES) {
      throw new DonationRefused(
        `The shared recording is ${formatBytes(totalBytes)}, above the ${formatBytes(MAX_DONATION_BYTES)} limit.`,
      );
    }
    if (!this.donationId) {
      this.set({ kind: 'creating', files: stored.files.length, bytes: totalBytes });
      this.checkCancel();
      this.donationId = await api.createDonation(job.meta, stored.files);
      this.sent = 0;
    }
    const id = this.donationId;
    for (; this.sent < stored.files.length; this.sent++) {
      const file = stored.files[this.sent];
      const sentBytes = stored.files.slice(0, this.sent).reduce((a, f) => a + f.bytes, 0);
      await this.uploadOne(id, file, sentBytes, totalBytes, stored);
    }
    this.checkCancel();
    this.set({ kind: 'finishing', donationId: id });
    await api.finishDonation(id);
  }

  private async uploadOne(
    id: string,
    file: DonationFile,
    sentBytes: number,
    totalBytes: number,
    stored: Stored,
  ): Promise<void> {
    const { api } = this.deps;
    const retries = this.deps.retries ?? UPLOAD_RETRIES;
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    for (let attempt = 1; ; attempt++) {
      this.checkCancel();
      this.set({
        kind: 'uploading',
        donationId: id,
        index: this.sent,
        count: stored.files.length,
        name: file.name,
        sentBytes,
        totalBytes,
        attempt,
      });
      try {
        const bytes = stored.inline.get(file.name) ?? (await this.deps.store.read(file.name));
        if (bytes.length !== file.bytes) {
          throw new DonationRefused(`${file.name} changed size since it was encoded.`);
        }
        const req = await api.donationUploadUrl(id, file.name);
        this.checkCancel();
        await api.putPresigned(req, bytes);
        return;
      } catch (err) {
        if (err instanceof Cancelled || err instanceof DonationRefused) throw err;
        if (attempt > retries) {
          throw new Error(`Uploading ${file.name} failed ${attempt} times: ${messageOf(err)}`, {
            cause: err,
          });
        }
        await sleep(1000 * 2 ** (attempt - 1));
      }
    }
  }

  private checkCancel(): void {
    if (this.cancelled) throw new Cancelled();
  }
}
