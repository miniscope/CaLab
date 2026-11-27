/**
 * The Final settle's frame supply on a live stream with `?factors` (look-back
 * worker 0): the frames the slow loop asks for, rebuilt
 * from the factor windows Discover wrote (`rebuildFrames`) and solved with
 * the newest published library, as `LookbackReader` does for a recording.
 * It reads only windows the compress worker reported done, whole, through
 * `FactorFiles` (no lock, no create, list or removal).
 */
import { factorName } from './compress-runner.ts';
import { rebuildFrames, type FactorWindowLike } from './factor-frames.ts';
import type { LookbackFrame, LookbackSolved } from './lookback-reader.ts';
import type { FactorFiles } from './window-store.ts';
import type { CompressedWindow } from '../workers/compress-types.ts';
import type { LookbackTiming } from './work-meter.ts';

/** What the look-back worker serves requests with (`LookbackReader` or `FactorReader`). */
export interface FrameServer {
  setLibrary(version: number, bytes: Uint8Array): void;
  serve(
    frames: LookbackFrame[],
    out: Float32Array,
    skip?: ArrayLike<number>,
  ): Promise<LookbackSolved>;
  dispose(): void;
}

/** A trace solver on one library (the WASM `TraceEngine`, or a fake). */
export interface FactorSolver {
  readonly cells: number;
  processFrames(y: Float32Array, n: number): Float32Array;
  lastBackground(): Float32Array;
  free(): void;
}

/** Windows kept decoded: the settle reads in plan order, so the current and the next are enough. */
export const FACTOR_CACHE = 2;

interface Cached {
  start: number;
  frames: number;
  win: FactorWindowLike;
  never: Uint8Array | null;
}

export class FactorReader implements FrameServer {
  private cache: Cached[] = [];
  private solver: FactorSolver | null = null;
  private version = 0;
  private pending: { version: number; bytes: Uint8Array } | null = null;
  private disposed = false;
  /** Window files read (each cache miss). */
  reads = 0;

  constructor(
    private readonly files: FactorFiles,
    private readonly windows: readonly CompressedWindow[],
    private readonly px: number,
    private readonly deps: {
      open(bytes: Uint8Array): FactorWindowLike;
      solver(library: Uint8Array): FactorSolver;
    },
  ) {}

  setLibrary(version: number, bytes: Uint8Array): void {
    if (version > this.version && version > (this.pending?.version ?? 0))
      this.pending = { version, bytes };
  }

  async serve(
    frames: LookbackFrame[],
    out: Float32Array,
    skip?: ArrayLike<number>,
  ): Promise<LookbackSolved> {
    if (out.length < frames.length * this.px)
      throw new RangeError(`factors: a buffer of ${out.length} for ${frames.length} frames`);
    const t0 = performance.now();
    const timing: LookbackTiming = {
      readMs: 0,
      preprocessMs: 0,
      solveMs: 0,
      otherMs: 0,
      waitMs: 0,
    };
    this.applyLibrary();
    const cells = this.solver?.cells ?? 0;
    const traces = new Float32Array(frames.length * cells);
    let background: Float32Array | undefined;
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i].frame;
      const y = out.subarray(i * this.px, (i + 1) * this.px);
      const r0 = performance.now();
      const w = await this.window(f);
      timing.readMs += performance.now() - r0;
      if (this.disposed) throw new Error('look-back stopped');
      const p0 = performance.now();
      rebuildFrames(w.win, w.never, f - w.start, 1, y);
      timing.preprocessMs += performance.now() - p0;
      if (!this.solver || cells === 0 || skip?.[i]) continue;
      const s0 = performance.now();
      traces.set(this.solver.processFrames(y, 1), i * cells);
      const bg = this.solver.lastBackground();
      background ??= new Float32Array(frames.length * bg.length);
      background.set(bg, i * bg.length);
      timing.solveMs += performance.now() - s0;
    }
    timing.otherMs = Math.max(
      0,
      performance.now() - t0 - timing.readMs - timing.preprocessMs - timing.solveMs,
    );
    return {
      version: this.solver ? this.version : 0,
      cells,
      traces,
      ...(background ? { background } : {}),
      timing,
    };
  }

  dispose(): void {
    this.disposed = true;
    for (const c of this.cache.splice(0)) c.win.free();
    this.solver?.free();
    this.solver = null;
  }

  private applyLibrary(): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    const next = this.deps.solver(p.bytes);
    this.solver?.free();
    this.solver = next;
    this.version = p.version;
  }

  private async window(frame: number): Promise<Cached> {
    if (this.disposed) throw new Error('look-back stopped');
    const hit = this.cache.find((c) => frame >= c.start && frame < c.start + c.frames);
    if (hit) return hit;
    const w = this.windows.find((x) => frame >= x.start && frame < x.start + x.frames);
    if (!w) throw new Error(`factors: frame ${frame} is in no compressed window`);
    const name = factorName(w.index);
    const win = this.deps.open(await this.files.read(name));
    if (win.start !== w.start || win.frames !== w.frames) {
      win.free();
      throw new Error(
        `factors: ${name} holds frames ${win.start}+${win.frames}, the compressor listed ${w.start}+${w.frames}`,
      );
    }
    this.reads++;
    const c: Cached = { start: w.start, frames: w.frames, win, never: win.neverValid?.() ?? null };
    this.cache.push(c);
    if (this.cache.length > FACTOR_CACHE) this.cache.shift()!.win.free();
    return c;
  }
}
