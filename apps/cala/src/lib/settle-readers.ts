/**
 * Final-settle readers (look-back worker 0's helpers; `workers/settle-reader-worker.ts`).
 *
 * The Final settle feeds a plan of past frames (`settlePlan`) to the slow loop
 * in requests of `SETTLE.batch` frames, and worker 0 answers each one: read,
 * the stateless half (recorded flicker, flat field, session warp, rigid
 * shift), the back half (one preprocessor run forward over the plan), then the
 * solve with the newest library. The stateless half is more than half of that
 * time and depends on nothing but the frame, so the readers do it ahead: when
 * the settle starts, the slow worker sends worker 0 the whole plan
 * (`settle-plan`), and worker 0 hands its chunks (the slow worker's requests,
 * in order) to `count` readers, at most `depth` chunks ahead of the request
 * being served. A request whose chunk is ready gets only the back half and the
 * solve on worker 0, in the same order and with the same library as before, so
 * the answers are the same bits (`prepareFrame` is the one stateless half both
 * paths run).
 *
 * Anything off the plan (a request that is not the next chunk, a reader that
 * failed, readers not up yet) is served the old way, on worker 0 alone.
 * Buffers come from worker 0's frame pool, so the frames in flight stay
 * bounded; a chunk's buffer becomes the answer's, which the slow worker sends
 * back. Pure orchestration: the readers are anything with `postMessage`, so it
 * is unit-tested with fakes.
 */
import type { FlatFieldMap } from './flat-field.ts';
import type { LookbackFrame, SettleReaderJob } from './lookback-reader.ts';
import type { LookbackSource } from '../workers/lookback-types.ts';

/** Worker 0 -> a settle reader. */
export type ToSettleReader =
  | {
      type: 'init';
      source: LookbackSource;
      /** Worker 0's front half (`Preprocessor.state()`), so the reader's front is the same. */
      front: Uint8Array;
      flat: FlatFieldMap | null;
      flatSeq: number;
    }
  /** A newer flat-field map (worker 0 got it from the main thread). */
  | { type: 'flat'; map: FlatFieldMap | null; seq: number }
  /** Prepare `job.frames` into `buf` (transferred; at least `frames * width * height`). */
  | { type: 'job'; id: number; job: SettleReaderJob; buf: Float32Array };

/** A settle reader -> worker 0. */
export type FromSettleReader =
  | { type: 'ready' }
  /** `buf` holds the prepared frames; `flatSeq`: the flat-field map they used; `busyMs`: read + prepare. */
  | { type: 'done'; id: number; buf: Float32Array; flatSeq: number; busyMs: number }
  /** `id` absent: the reader could not start. */
  | { type: 'error'; id?: number; message: string };

export interface SettleReaderLike {
  postMessage(msg: ToSettleReader, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<FromSettleReader>) => void) | null;
  onerror?: ((e: ErrorEvent) => void) | null;
  terminate(): void;
}

/** A chunk worker 0 can use: the frames prepared, and the flat-field map they used. */
export interface PreparedChunk {
  buf: Float32Array;
  flatSeq: number;
}

/** What the readers need of worker 0. */
export interface SettleReadersHost {
  makeReader(): SettleReaderLike;
  /** A frame buffer of the pool (waits while all are out). */
  acquire(): Promise<Float32Array>;
  release(buf: Float32Array): void;
  /** A buffer that will never come back (its reader was ended with it): the pool may make another. */
  forget(): void;
  /** Rows and warps of `frames` (waits for rows not recorded yet). */
  job(frames: readonly number[]): Promise<SettleReaderJob>;
}

interface Chunk {
  frames: number[];
  blocks: number[];
  state: 'waiting' | 'sent' | 'ready' | 'failed' | 'done';
  result: PreparedChunk | null;
  /** Resolves when the chunk is ready or failed. */
  settled: Promise<void>;
  resolve: () => void;
}

interface Reader {
  port: SettleReaderLike;
  ready: boolean;
  dead: boolean;
  /** The chunk out with it (index), or -1. */
  out: number;
  /** That chunk's buffer has been posted to it (it comes back with the answer, or never). */
  holding: boolean;
  busyMs: number;
}

/**
 * The readers of one Final settle: `start` with the plan, `take` per request,
 * `stop` at the end (or when the run goes). One instance per settle.
 */
export class SettleReaders {
  private readonly chunks: Chunk[];
  private readonly readers: Reader[] = [];
  /** Next chunk to hand out, and next chunk a request should be. */
  private next = 0;
  private head = 0;
  private stopped = false;
  private nextId = 1;
  private flat: { map: FlatFieldMap | null; seq: number };

  constructor(
    private readonly host: SettleReadersHost,
    plan: readonly LookbackFrame[],
    private readonly opts: {
      count: number;
      /** Chunks handed out or ready ahead of the request being served. */
      depth: number;
      /** Frames per chunk (the slow worker's request size, `SETTLE.batch`). */
      chunk: number;
      source: LookbackSource;
      front: Uint8Array;
      flat: { map: FlatFieldMap | null; seq: number };
    },
  ) {
    this.flat = opts.flat;
    this.chunks = [];
    for (let i = 0; i < plan.length; i += opts.chunk) {
      const part = plan.slice(i, i + opts.chunk);
      let resolve!: () => void;
      const settled = new Promise<void>((r) => (resolve = r));
      this.chunks.push({
        frames: part.map((f) => f.frame),
        blocks: part.map((f) => f.block),
        state: 'waiting',
        result: null,
        settled,
        resolve,
      });
    }
    for (let i = 0; i < opts.count; i++) this.addReader();
  }

  private addReader(): void {
    const port = this.host.makeReader();
    const r: Reader = { port, ready: false, dead: false, out: -1, holding: false, busyMs: 0 };
    port.onmessage = (e) => this.onReader(r, e.data);
    if ('onerror' in port)
      port.onerror = (e) => this.readerFailed(r, e?.message || 'settle reader crashed');
    this.readers.push(r);
    port.postMessage({
      type: 'init',
      source: this.opts.source,
      // A copy each (the state is small; each reader keeps its own).
      front: this.opts.front.slice(),
      flat: this.flat.map,
      flatSeq: this.flat.seq,
    });
  }

  private onReader(r: Reader, msg: FromSettleReader): void {
    if (r.dead) {
      // A late answer of an ended reader: its buffer goes back to the pool.
      if (msg.type === 'done') this.host.release(msg.buf);
      return;
    }
    switch (msg.type) {
      case 'ready':
        r.ready = true;
        this.pump();
        return;
      case 'done': {
        r.busyMs += msg.busyMs;
        const i = r.out;
        r.out = -1;
        r.holding = false;
        const c = this.chunks[i];
        if (this.stopped || !c || c.state !== 'sent') this.host.release(msg.buf);
        else {
          c.state = 'ready';
          c.result = { buf: msg.buf, flatSeq: msg.flatSeq };
          c.resolve();
        }
        if (this.stopped) this.endReader(r);
        else this.pump();
        return;
      }
      case 'error':
        this.readerFailed(r, msg.message);
        return;
    }
  }

  /** A reader that failed is left out; its chunk (and its buffer) is lost and served on worker 0. */
  private readerFailed(r: Reader, message: string): void {
    if (r.dead) return;
    console.warn(`cala settle reader stopped: ${message}`);
    const i = r.out;
    r.out = -1;
    // The buffer went with the job.
    if (r.holding) this.host.forget();
    r.holding = false;
    if (i >= 0) {
      const c = this.chunks[i];
      if (c && c.state === 'sent') {
        c.state = 'failed';
        c.resolve();
      }
    }
    r.dead = true;
    r.port.terminate();
    if (!this.stopped) this.pump();
  }

  private endReader(r: Reader): void {
    if (r.dead) return;
    r.dead = true;
    r.port.terminate();
  }

  /** Hand out chunks to idle readers, up to `depth` ahead of the request being served. */
  private pump(): void {
    while (
      !this.stopped &&
      this.next < this.chunks.length &&
      this.next - this.head < this.opts.depth
    ) {
      const r = this.readers.find((x) => x.ready && !x.dead && x.out < 0);
      if (!r) return;
      const i = this.next++;
      r.out = i;
      const c = this.chunks[i];
      c.state = 'sent';
      void this.send(r, i, c);
    }
  }

  private async send(r: Reader, i: number, c: Chunk): Promise<void> {
    let buf: Float32Array | null = null;
    try {
      const job = await this.host.job(c.frames);
      buf = await this.host.acquire();
      if (this.stopped || r.dead || r.out !== i) {
        this.host.release(buf);
        if (r.out === i) r.out = -1;
        if (this.stopped) this.endReader(r);
        else if (!r.dead) this.pump();
        return;
      }
      r.holding = true;
      r.port.postMessage({ type: 'job', id: this.nextId++, job, buf }, [
        buf.buffer as ArrayBuffer,
        job.frames.buffer as ArrayBuffer,
      ]);
    } catch (err) {
      if (buf) this.host.release(buf);
      // Rows that never came (look-back stopped): the chunk is served on worker 0.
      if (r.out === i) r.out = -1;
      if (c.state === 'sent') {
        c.state = 'failed';
        c.resolve();
      }
      if (this.stopped) this.endReader(r);
      void err;
    }
  }

  /**
   * The prepared frames of a request (in order), or null: serve it on worker
   * 0 alone. A request that is not the next chunk of the plan ends the
   * readers (the settle went off the plan).
   */
  async take(frames: readonly LookbackFrame[]): Promise<PreparedChunk | null> {
    if (this.stopped) return null;
    const matches = (c: Chunk | undefined) =>
      c !== undefined &&
      c.frames.length === frames.length &&
      frames.every((f, k) => f.frame === c.frames[k] && f.block === c.blocks[k]);
    // Requests served before the readers were set up are passed over (none handed out then).
    let at = this.head;
    while (
      at < this.chunks.length &&
      this.chunks[at].state === 'waiting' &&
      !matches(this.chunks[at])
    )
      at++;
    const c = this.chunks[at];
    if (!matches(c)) {
      this.stop();
      return null;
    }
    for (let k = this.head; k < at; k++) this.chunks[k].state = 'done';
    this.head = at + 1;
    if (c.state === 'waiting') {
      // Not handed out yet (readers starting): worker 0 serves it; nobody else will.
      c.state = 'done';
      if (this.next < this.head) this.next = this.head;
      this.pump();
      return null;
    }
    await c.settled;
    const res = c.state === 'ready' ? c.result : null;
    c.state = 'done';
    c.result = null;
    this.pump();
    return res;
  }

  /** A newer flat-field map: the readers use it from their next chunk. */
  setFlat(map: FlatFieldMap | null, seq: number): void {
    this.flat = { map, seq };
    for (const r of this.readers) if (!r.dead) r.port.postMessage({ type: 'flat', map, seq });
  }

  /** Busy ms per reader since the last call (instrumentation). */
  drainBusy(): number[] {
    return this.readers.map((r) => {
      const v = r.busyMs;
      r.busyMs = 0;
      return v;
    });
  }

  /** Readers that are up and not failed. */
  get live(): number {
    return this.readers.filter((r) => r.ready && !r.dead).length;
  }

  /**
   * The settle ended (or the run): no more chunks. Ready chunks give their
   * buffers back; a reader with a chunk out ends once it answers (its buffer
   * comes back with it), the others at once.
   */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const c of this.chunks) {
      if (c.state === 'ready' && c.result) this.host.release(c.result.buf);
      if (c.state === 'ready' || c.state === 'sent') {
        c.state = 'failed';
        c.result = null;
        c.resolve();
      }
    }
    for (const r of this.readers) if (r.out < 0) this.endReader(r);
  }

  /** End every reader now (the worker is going): buffers still out are written off. */
  dispose(): void {
    this.stop();
    for (const r of this.readers) {
      if (r.dead) continue;
      if (r.holding) this.host.forget();
      r.holding = false;
      r.out = -1;
      this.endReader(r);
    }
  }
}

/**
 * Final-settle readers for a machine with `cores` logical cores, or the
 * `override` (`?debug&settlereaders=N`, 0 = none: worker 0 alone, as before).
 * Readers take the cores the frame loop leaves idle after Discover's last
 * frame; one reader already prepares frames faster than the slow worker
 * observes them on the sims measured, two leave headroom.
 */
export const SETTLE_READERS = { workers: 2, minCores: 6, maxWorkers: 4 } as const;

export function settleReaderCount(cores: number | undefined, override?: number | null): number {
  if (override !== undefined && override !== null && Number.isFinite(override))
    return Math.max(0, Math.min(SETTLE_READERS.maxWorkers, Math.floor(override)));
  if (cores === undefined) return 0;
  return cores >= SETTLE_READERS.minCores ? SETTLE_READERS.workers : cores >= 4 ? 1 : 0;
}
