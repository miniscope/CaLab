/**
 * Frame source for a live recording: raw frames pushed by an acquisition
 * side over a WebSocket (the simulator in `scripts/live-sim.mjs`, or
 * anything that speaks the same protocol) and consumed by the pipeline as an
 * unbounded stream: no frame count, no random access, and the run ends when
 * the stream ends or the user stops it.
 *
 * Protocol (one connection = one recording):
 *   - a text frame `{"type":"hello", width, height, bitDepth, fps, fourcc,
 *     bottomUp, name}` first;
 *   - then one binary frame per video frame: `LIVE_HEADER_BYTES` of header
 *     (u32 magic `CALF`, u32 frame index on the acquisition side, f64
 *     timestamp in ms) followed by the pixels, rows as stored;
 *   - `{"type":"end", frames}` when the recording ends. A socket that closes
 *     without it ends the stream too (a dropped link).
 *
 * The pipeline reads frames by their index in the *processed* stream, which
 * is the order they arrived in: a frame the acquisition side never sent
 * (its index jumps) or one this source had to drop (the pipeline was behind
 * by more than the queue holds) is counted, and the next frame simply
 * follows. The pipeline's three walks (calibration, motion warm-up, then
 * every frame) re-read the first frames, so those stay in the queue until
 * the processing walk is past them.
 *
 * Transport-free: fed through `onSocketMessage` / `onSocketClose` by a
 * socket-like object, so it is tested with a fake socket.
 */
import type { FramePixels, FrameSourceInfo } from './frame-source.ts';
import { ASSUMED_FPS } from './miniscope-meta.ts';
import type { FrameReader, LiveBatchInfo } from './pipeline-engine.ts';
import { UNBOUNDED } from './pipeline-plan.ts';

/** Bytes before the pixels of a binary frame. */
export const LIVE_HEADER_BYTES = 16;
/** `CALF`, little-endian. */
export const LIVE_MAGIC = 0x464c4143;

/** What `hello` carries. */
export interface LiveHello {
  type: 'hello';
  width: number;
  height: number;
  bitDepth: number;
  fps: number | null;
  fourcc?: string;
  bottomUp?: boolean;
  /** A label for the header (the recording or device name). */
  name?: string;
  /** A serial number of the physical sensor, if the source knows it (the flat-field cache key). */
  serial?: string;
}

export type LiveControl = LiveHello | { type: 'end'; frames?: number };

/** The parts of a `WebSocket` the source uses (a fake in tests). */
export interface SocketLike {
  binaryType: string;
  onmessage: ((e: { data: ArrayBuffer | string }) => void) | null;
  onclose: ((e: { code?: number; reason?: string }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  close(): void;
}

/** Counters of a live stream (all frames, since the connection). */
export interface LiveStats {
  /** Frames received whole. */
  received: number;
  /** Frames the acquisition side never delivered (gaps in its indices). */
  missed: number;
  /** Frames received but dropped here because the queue was full. */
  dropped: number;
  /** Frames that arrived out of order (dropped). */
  outOfOrder: number;
  /** Frames received and not yet read by the pipeline. */
  queued: number;
  /** Bytes the queue holds. */
  queuedBytes: number;
  /** The stream ended (`end` received, the socket closed, or `stop`). */
  ended: boolean;
  /** True when the socket closed before `end`. */
  aborted: boolean;
  /** Wall time of the last frame's arrival (performance.now()). */
  lastArrivalMs: number;
}

export interface LiveSourceOptions {
  /** Frames kept for the pipeline's re-reads (the longer of its warm-ups). */
  retainFrames?: number;
  /** Most bytes of frames queued before new frames are dropped. */
  maxQueuedBytes?: number;
  now?: () => number;
}

export const LIVE_DEFAULTS = {
  retainFrames: 200,
  // 700 frames of 600 x 600 8-bit video (35 s at 20 fps).
  maxQueuedBytes: 256 * 1048576,
} as const;

interface Queued {
  pixels: FramePixels;
  /** Index on the acquisition side. */
  sourceIndex: number;
  /** Arrival time, performance.now(). */
  arrivedMs: number;
  /** Timestamp the acquisition side sent, ms. */
  stampMs: number;
}

function parseControl(text: string): LiveControl {
  let msg: unknown;
  try {
    msg = JSON.parse(text);
  } catch {
    throw new Error('The live source sent a text frame that is not JSON.');
  }
  if (!msg || typeof msg !== 'object' || typeof (msg as { type?: unknown }).type !== 'string')
    throw new Error('The live source sent a message without a type.');
  const m = msg as Record<string, unknown>;
  if (m.type === 'hello') {
    const num = (k: string): number => {
      const v = m[k];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 1)
        throw new Error(`The live source's hello has no valid ${k}.`);
      return Math.floor(v);
    };
    const fps = typeof m.fps === 'number' && m.fps > 0 ? m.fps : null;
    const bitDepth = num('bitDepth');
    if (bitDepth !== 8 && bitDepth !== 16)
      throw new Error(`The live source sends ${bitDepth}-bit frames; only 8 and 16 are supported.`);
    return {
      type: 'hello',
      width: num('width'),
      height: num('height'),
      bitDepth,
      fps,
      ...(typeof m.fourcc === 'string' ? { fourcc: m.fourcc } : {}),
      ...(typeof m.bottomUp === 'boolean' ? { bottomUp: m.bottomUp } : {}),
      ...(typeof m.name === 'string' ? { name: m.name } : {}),
      ...(typeof m.serial === 'string' && m.serial.trim() !== '' ? { serial: m.serial } : {}),
    };
  }
  if (m.type === 'end')
    return { type: 'end', ...(typeof m.frames === 'number' ? { frames: m.frames } : {}) };
  throw new Error(`The live source sent an unknown message type "${m.type}".`);
}

/** `FrameSourceInfo` of a live stream (no files, no frame count). */
export function liveInfo(hello: LiveHello, url: string): FrameSourceInfo {
  return {
    frameCount: UNBOUNDED,
    width: hello.width,
    height: hello.height,
    bitDepth: hello.bitDepth,
    fourcc: hello.fourcc ?? 'GREY',
    bottomUp: hello.bottomUp ?? false,
    fps: hello.fps,
    fpsSource: hello.fps === null ? 'none' : 'live',
    fpsFromMetadata: null,
    fpsFromTimestamps: null,
    aviDeclaredFps: null,
    timestampCount: null,
    files: [],
    ignoredFiles: [],
    warnings:
      hello.fps === null
        ? [`The live source gave no frame rate; time-based settings assume ${ASSUMED_FPS} Hz.`]
        : [],
    live: { url, ...(hello.name ? { name: hello.name } : {}) },
    ...(hello.serial ? { device: { serial: hello.serial } } : {}),
  };
}

export class LiveSource implements FrameReader {
  readonly info: FrameSourceInfo;
  private readonly o: Required<Omit<LiveSourceOptions, 'now'>>;
  private readonly now: () => number;
  private readonly px: number;
  private readonly bytesPerFrame: number;
  private readonly socket: SocketLike;
  /** Frames from stream index `queueStart` on, oldest first. */
  private queue: Queued[] = [];
  private queueStart = 0;
  private queueBytes = 0;
  /** Stream index after the newest queued frame: the frames received and kept. */
  private end = 0;
  /** Stream index the processing walk has read up to (frames below `queueStart` are gone). */
  private nextSource = 0;
  private counters = { received: 0, missed: 0, dropped: 0, outOfOrder: 0 };
  private ended = false;
  private aborted = false;
  private lastArrivalMs = 0;
  private lastReadArrivalMs = 0;
  private waiters: {
    end: number;
    resolve: (total: number) => void;
    reject: (err: Error) => void;
  }[] = [];
  private readCalled = false;
  private failure: Error | null = null;
  private onFailure: ((err: Error) => void) | null = null;

  private constructor(socket: SocketLike, info: FrameSourceInfo, options: LiveSourceOptions) {
    this.socket = socket;
    this.info = info;
    this.o = { ...LIVE_DEFAULTS, ...options };
    this.now = options.now ?? (() => performance.now());
    this.px = info.width * info.height;
    this.bytesPerFrame = this.px * (info.bitDepth === 16 ? 2 : 1);
  }

  /**
   * Take over `socket` (already connecting or open) and wait for its hello.
   * Rejects when the socket closes or sends frames before it.
   */
  static open(
    socket: SocketLike,
    url: string,
    options: LiveSourceOptions = {},
  ): Promise<LiveSource> {
    socket.binaryType = 'arraybuffer';
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        socket.onmessage = socket.onclose = socket.onerror = null;
        try {
          socket.close();
        } catch {
          // Already closed.
        }
        reject(err);
      };
      socket.onerror = () => fail(new Error(`Could not connect to the live source at ${url}.`));
      socket.onclose = () => fail(new Error(`The live source at ${url} closed before its hello.`));
      socket.onmessage = (e) => {
        if (typeof e.data !== 'string')
          return fail(new Error('The live source sent frames before its hello.'));
        let hello: LiveControl;
        try {
          hello = parseControl(e.data);
        } catch (err) {
          return fail(err as Error);
        }
        if (hello.type !== 'hello')
          return fail(new Error('The live source ended before its hello.'));
        settled = true;
        const source = new LiveSource(socket, liveInfo(hello, url), options);
        socket.onmessage = (ev) => source.onSocketMessage(ev.data);
        socket.onclose = () => source.onSocketClose();
        socket.onerror = () => source.onSocketClose();
        resolve(source);
      };
    });
  }

  /** A message from the socket: a frame, or `end`. */
  onSocketMessage(data: ArrayBuffer | string): void {
    if (this.ended) return;
    if (typeof data === 'string') {
      let msg: LiveControl;
      try {
        msg = parseControl(data);
      } catch (err) {
        return this.fail(err as Error);
      }
      if (msg.type === 'end') this.finish(false);
      return;
    }
    const t = this.now();
    if (data.byteLength !== LIVE_HEADER_BYTES + this.bytesPerFrame) {
      return this.fail(
        new Error(
          `The live source sent a frame of ${data.byteLength} bytes; expected ${LIVE_HEADER_BYTES + this.bytesPerFrame}.`,
        ),
      );
    }
    const head = new DataView(data, 0, LIVE_HEADER_BYTES);
    if (head.getUint32(0, true) !== LIVE_MAGIC)
      return this.fail(new Error('The live source sent a frame with a bad header.'));
    const sourceIndex = head.getUint32(4, true);
    const stampMs = head.getFloat64(8, true);
    this.counters.received++;
    this.lastArrivalMs = t;
    if (sourceIndex < this.nextSource) {
      this.counters.outOfOrder++;
      return;
    }
    this.counters.missed += sourceIndex - this.nextSource;
    this.nextSource = sourceIndex + 1;
    if (this.queueBytes + this.bytesPerFrame > this.queueLimit()) {
      this.counters.dropped++;
      return;
    }
    const pixels =
      this.info.bitDepth === 16
        ? new Uint16Array(data.slice(LIVE_HEADER_BYTES))
        : new Uint8Array(data, LIVE_HEADER_BYTES);
    this.queue.push({ pixels, sourceIndex, arrivedMs: t, stampMs });
    this.queueBytes += this.bytesPerFrame;
    this.end++;
    this.wake();
  }

  /** The socket closed: the stream ends at the frames received. */
  onSocketClose(): void {
    if (!this.ended) this.finish(true);
  }

  /** The user stopped the recording: the stream ends here and the socket is closed. */
  stop(): void {
    if (this.ended) return;
    this.finish(false);
    this.closeSocket();
  }

  /** Called with the error that ended the stream (a bad frame, a protocol error). */
  set onError(handler: ((err: Error) => void) | null) {
    this.onFailure = handler;
    if (handler && this.failure) handler(this.failure);
  }

  stats(): LiveStats {
    return {
      ...this.counters,
      queued: this.queue.length,
      queuedBytes: this.queueBytes,
      ended: this.ended,
      aborted: this.aborted,
      lastArrivalMs: this.lastArrivalMs,
    };
  }

  /** Frames received and kept (the stream's length once it ended). */
  get frames(): number {
    return this.end;
  }

  /** True once a frame was read: the stream has been consumed from its start. */
  get used(): boolean {
    return this.readCalled;
  }

  /** How many first frames to keep for re-reads (the pipeline's longest warm-up). */
  setRetainFrames(n: number): void {
    this.o.retainFrames = Math.max(0, Math.floor(n));
  }

  /**
   * Resolves once frames below `end` can be read, with `UNBOUNDED`, or, when
   * the stream ended first, with its final frame count.
   */
  waitFor(end: number): Promise<number> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.end >= end) return Promise.resolve(this.ended ? this.end : UNBOUNDED);
    if (this.ended) return Promise.resolve(this.end);
    return new Promise((resolve, reject) => this.waiters.push({ end, resolve, reject }));
  }

  /**
   * `count` frames from stream index `start`: either among the retained first
   * frames (re-read by the warm-ups), or the next frames of the processing
   * walk, which must read in order. A read that reaches past the retained
   * frames releases everything it read and what came before.
   */
  async readFrames(start: number, count: number, out?: FramePixels): Promise<FramePixels> {
    if (!Number.isInteger(start) || !Number.isInteger(count) || count < 1 || start < 0)
      throw new RangeError(`Bad live read ${start}..${start + count}.`);
    this.readCalled = true;
    const total = await this.waitFor(start + count);
    if (start + count > total)
      throw new RangeError(
        `Frames ${start}..${start + count} are past the end of the stream (${total}).`,
      );
    if (start < this.queueStart)
      throw new RangeError(
        `Frames ${start}..${start + count} of the live stream were released already.`,
      );
    const sixteen = this.info.bitDepth === 16;
    const n = count * this.px;
    if (out && (out.length !== n || out instanceof Uint16Array !== sixteen))
      throw new TypeError(
        `out must be a ${sixteen ? 'Uint16Array' : 'Uint8Array'} of ${n} elements.`,
      );
    const dst = out ?? (sixteen ? new Uint16Array(n) : new Uint8Array(n));
    for (let i = 0; i < count; i++) {
      const q = this.queue[start + i - this.queueStart];
      dst.set(q.pixels, i * this.px);
      this.lastReadArrivalMs = q.arrivedMs;
    }
    if (start + count > this.o.retainFrames) this.release(start + count);
    return dst;
  }

  /** Stats of the batch just read, for the pipeline's step result. */
  liveInfo(): LiveBatchInfo {
    const c = this.counters;
    return {
      received: c.received,
      dropped: c.dropped + c.outOfOrder,
      missed: c.missed,
      queued: this.queue.length,
      lagMs: this.lastReadArrivalMs > 0 ? this.now() - this.lastReadArrivalMs : 0,
    };
  }

  /** Close the socket and drop the queue. The source is unusable afterwards. */
  dispose(): void {
    this.stop();
    this.queue = [];
    this.queueBytes = 0;
  }

  /** The byte cap, but always room for the retained frames plus a few reads. */
  private queueLimit(): number {
    return Math.max(this.o.maxQueuedBytes, (this.o.retainFrames + 128) * this.bytesPerFrame);
  }

  private release(before: number): void {
    const n = Math.min(before - this.queueStart, this.queue.length);
    if (n <= 0) return;
    this.queue.splice(0, n);
    this.queueStart += n;
    this.queueBytes -= n * this.bytesPerFrame;
  }

  private finish(aborted: boolean): void {
    this.ended = true;
    this.aborted = aborted;
    this.wake();
  }

  private fail(err: Error): void {
    this.failure = err;
    this.finish(true);
    this.closeSocket();
    this.onFailure?.(err);
  }

  private closeSocket(): void {
    this.socket.onmessage = this.socket.onclose = this.socket.onerror = null;
    try {
      this.socket.close();
    } catch {
      // Already closed.
    }
  }

  private wake(): void {
    if (this.waiters.length === 0) return;
    if (this.failure) {
      const err = this.failure;
      const all = this.waiters;
      this.waiters = [];
      for (const w of all) w.reject(err);
      return;
    }
    const ready = this.waiters.filter((w) => this.ended || this.end >= w.end);
    if (ready.length === 0) return;
    this.waiters = this.waiters.filter((w) => !ready.includes(w));
    const total = this.ended ? this.end : UNBOUNDED;
    for (const w of ready) w.resolve(total);
  }
}
