/**
 * The compress pool (docs/superpowers/plans/2026-11-23-cala-parallel-compress-slice5.md):
 * the compress worker (the coordinator) shares the tiles of each window with
 * helper workers. Only the coordinator touches OPFS: it reads a tile from the
 * window file and hands it to a free slot (itself or a helper); a helper
 * compresses it and sends back the tile's factor bytes, which the coordinator
 * writes in tile order. The seed of a tile depends only on its window and
 * index and `TileCompressor` is stateless, so the factor files are the same
 * bytes for any number of workers.
 *
 * Sizing (`compressPoolSize`): few workers while Discover reads (it keeps its
 * cores), more after its last frame, when the pipeline's stage workers are idle.
 */
import type { CoordinatorToHelper, HelperToCoordinator } from '../workers/compress-types.ts';
import type { PortLike } from '../workers/slow-types.ts';

// ---- sizing ----

export const COMPRESS_POOL = {
  /** Compress workers at most (the coordinator included). */
  max: 4,
  /**
   * Threads Discover keeps busy besides the visit workers and the settle pool:
   * the 5 reserved threads (`RESERVED_THREADS`), look-back worker 0 and the coordinator.
   */
  discoverReserve: 6,
  /** After Discover's last frame: the main thread, the slow worker and look-back worker 0. */
  afterReserve: 3,
} as const;

/** Compress workers of a run: while Discover reads, and from its last frame on. */
export interface PoolWidth {
  discover: number;
  after: number;
}

const clampWidth = (n: number): number =>
  Math.max(1, Math.min(COMPRESS_POOL.max, Number.isFinite(n) ? Math.floor(n) : 1));

/**
 * The pool's widths on a machine with `cores` logical cores
 * (`navigator.hardwareConcurrency`; unknown: 1 and 1), `visitWorkers` visit
 * workers and a settle pool of `settlePool` look-back workers.
 */
export function compressPoolSize(
  cores: number | undefined,
  visitWorkers: number,
  settlePool: number,
): PoolWidth {
  if (cores === undefined || !Number.isFinite(cores)) return { discover: 1, after: 1 };
  const busy = visitWorkers + settlePool;
  return {
    discover: clampWidth(cores - COMPRESS_POOL.discoverReserve - busy),
    after: clampWidth(cores - COMPRESS_POOL.afterReserve - busy),
  };
}

/** `?debug&cpool=D,E`: both widths, each 1 to `COMPRESS_POOL.max` (anything else: null). */
export function parsePoolOverride(v: string | null): PoolWidth | null {
  const m = /^\s*(\d+)\s*,\s*(\d+)\s*$/.exec(v ?? '');
  if (!m) return null;
  const [d, e] = [Number(m[1]), Number(m[2])];
  const ok = (n: number): boolean => n >= 1 && n <= COMPRESS_POOL.max;
  return ok(d) && ok(e) ? { discover: d, after: e } : null;
}

/** The widths a run compresses with: a live stream keeps one worker while it streams. */
export function poolForRun(live: boolean, pool: PoolWidth | null): PoolWidth | null {
  if (!pool) return null;
  return live ? { discover: 1, after: pool.after } : pool;
}

// ---- the tile pool ----

/** One tile of a window to compress. */
export interface TileJob {
  window: number;
  tile: number;
  frames: number;
  x0: number;
  y0: number;
  w: number;
  h: number;
  seed: number;
}

/** A compressed tile: its kept rank, compute time (ms) and `TileFactors.toBytes()`. */
export interface TileResult {
  rank: number;
  ms: number;
  bytes: Uint8Array;
}

/** What the coordinator compresses with itself (the WASM `TileCompressor`). */
export interface LocalCompressor {
  compress(
    raw: Int16Array,
    frames: number,
    x0: number,
    y0: number,
    w: number,
    h: number,
    seed: number,
  ): { readonly rank: number; toBytes(): Uint8Array; free(): void };
}

/** The window's file side, owned by the coordinator. */
export interface WindowIO {
  local: LocalCompressor;
  /** Fill `into` (`frames * w * h` values) with the tile's quantized frames. */
  read(job: TileJob, into: Int16Array): void;
  /** Called once per tile, in tile order. */
  write(job: TileJob, result: TileResult): void;
  yieldNow(): Promise<void>;
}

/** What the runner needs of a pool (tests pass fakes). */
export interface TilePoolLike {
  /** A new run: tiles of earlier runs are dropped; the helpers make a compressor for `quant`. */
  begin(quant: number): void;
  setWidth(n: number): void;
  /** Slots in use: the coordinator and the live helpers, at most the width. */
  width(): number;
  /** Drop what is in flight; a running `compressWindow` returns false. */
  reset(): void;
  /** Compress every tile and write them in order; false when reset, throws on a tile's error. */
  compressWindow(jobs: TileJob[], io: WindowIO): Promise<boolean>;
}

/** A tile a helper did not answer within this long: the helper is given up. */
export const TILE_TIMEOUT_MS = 60_000;

interface Helper {
  port: PortLike<CoordinatorToHelper>;
  alive: boolean;
  /** The tile it is compressing (of generation `gen`), and its timer. */
  busy: { gen: number; window: number; tile: number; timer: unknown } | null;
  /** A buffer it sent back, reused for its next tile. */
  spare: Int16Array | null;
}

interface WindowRun {
  gen: number;
  jobs: TileJob[];
  /** Tiles not handed out yet (a lost helper's tile goes back to the front). */
  queue: number[];
  results: Map<number, TileResult>;
  written: number;
  error: Error | null;
  wake: (() => void) | null;
}

export interface TilePoolDeps {
  helpers: PortLike<CoordinatorToHelper>[];
  now?: () => number;
  timeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

/**
 * Spreads one window's tiles over the coordinator and the helpers (at most
 * `width` slots). Answers wait in a map until every earlier tile is written.
 * Every tile handed out settles: an answer, an error (the window fails), a
 * lost helper (crash, failed start or timeout: the tile is read again and
 * redone elsewhere), or a reset.
 */
export class TilePool implements TilePoolLike {
  private readonly helpers: Helper[];
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;
  private gen = 0;
  private wanted = 1;
  private run: WindowRun | null = null;
  private scratch = new Int16Array(0);

  constructor(deps: TilePoolDeps) {
    this.helpers = deps.helpers.map((port) => ({ port, alive: true, busy: null, spare: null }));
    this.now = deps.now ?? (() => performance.now());
    this.timeoutMs = deps.timeoutMs ?? TILE_TIMEOUT_MS;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  begin(quant: number): void {
    this.reset();
    for (const h of this.helpers) if (h.alive) h.port.postMessage({ type: 'init', quant });
  }

  setWidth(n: number): void {
    this.wanted = Math.max(1, Math.floor(n) || 1);
    this.run?.wake?.();
  }

  width(): number {
    const live = this.helpers.filter((h) => h.alive).length;
    return Math.min(this.wanted, 1 + live);
  }

  reset(): void {
    this.gen++;
    for (const h of this.helpers) this.release(h);
    const run = this.run;
    this.run = null;
    run?.wake?.();
  }

  /** A message from helper `k`. */
  onHelper(k: number, msg: HelperToCoordinator): void {
    const h = this.helpers[k];
    if (!h) return;
    if (msg.type === 'helper-error') {
      this.lost(k);
      return;
    }
    if (msg.type === 'tile-done' && h.spare === null) h.spare = msg.raw;
    const b = h.busy;
    // A late answer of an earlier run or of a tile already given up.
    if (!b || b.gen !== msg.epoch || b.window !== msg.window || b.tile !== msg.tile) return;
    this.release(h);
    const run = this.run;
    if (!run || run.gen !== msg.epoch || run.jobs[0]?.window !== msg.window) return;
    if (msg.type === 'tile-done') {
      run.results.set(msg.tile, { rank: msg.rank, ms: msg.ms, bytes: msg.bytes });
    } else {
      run.error ??= new Error(msg.message);
    }
    run.wake?.();
  }

  /** Helper `k` crashed, could not start or timed out: its tile is redone elsewhere, and it gets no more. */
  lost(k: number): void {
    const h = this.helpers[k];
    if (!h || !h.alive) return;
    h.alive = false;
    const b = h.busy;
    this.release(h);
    const run = this.run;
    if (b && run && run.gen === b.gen && b.window === run.jobs[0]?.window)
      run.queue.unshift(b.tile);
    run?.wake?.();
  }

  async compressWindow(jobs: TileJob[], io: WindowIO): Promise<boolean> {
    if (this.run) throw new Error('TilePool compresses one window at a time.');
    const run: WindowRun = {
      gen: this.gen,
      jobs,
      queue: jobs.map((_, i) => i),
      results: new Map(),
      written: 0,
      error: null,
      wake: null,
    };
    this.run = run;
    const current = (): boolean => run.gen === this.gen;
    try {
      while (current()) {
        if (run.error) throw run.error;
        this.flush(run, io);
        if (run.written >= jobs.length) return true;
        this.dispatch(run, io);
        const i = run.queue.shift();
        if (i !== undefined) {
          // The coordinator's own slot.
          run.results.set(i, this.compressHere(jobs[i], io));
          this.flush(run, io);
          await io.yieldNow();
          continue;
        }
        // Every tile is out: wait for an answer, a loss or a reset.
        await new Promise<void>((resolve) => {
          run.wake = resolve;
        });
        run.wake = null;
      }
      return false;
    } finally {
      if (this.run === run) this.run = null;
    }
  }

  private compressHere(job: TileJob, io: WindowIO): TileResult {
    const n = job.frames * job.w * job.h;
    if (this.scratch.length < n) this.scratch = new Int16Array(n);
    const raw = this.scratch.subarray(0, n);
    io.read(job, raw);
    const t0 = this.now();
    const f = io.local.compress(raw, job.frames, job.x0, job.y0, job.w, job.h, job.seed);
    try {
      const ms = this.now() - t0;
      return { rank: f.rank, ms, bytes: f.toBytes() };
    } finally {
      f.free();
    }
  }

  /** Hand tiles to free helpers, up to the width (the coordinator is one slot). */
  private dispatch(run: WindowRun, io: WindowIO): void {
    let slots = this.width() - 1 - this.helpers.filter((h) => h.busy).length;
    for (let k = 0; k < this.helpers.length && slots > 0 && run.queue.length > 0; k++) {
      const h = this.helpers[k];
      if (!h.alive || h.busy) continue;
      const i = run.queue.shift()!;
      const job = run.jobs[i];
      const n = job.frames * job.w * job.h;
      // The whole buffer travels (the helper reads its first `frames * w * h` values).
      const raw = h.spare && h.spare.length >= n ? h.spare : new Int16Array(n);
      h.spare = null;
      io.read(job, raw.subarray(0, n));
      const timer = this.setTimer(() => this.lost(k), this.timeoutMs);
      h.busy = { gen: run.gen, window: job.window, tile: job.tile, timer };
      h.port.postMessage({ type: 'tile', epoch: run.gen, ...job, raw }, [
        raw.buffer as ArrayBuffer,
      ]);
      slots--;
    }
  }

  /** Write the answers that are next in tile order. */
  private flush(run: WindowRun, io: WindowIO): void {
    for (;;) {
      const r = run.results.get(run.written);
      if (!r) return;
      run.results.delete(run.written);
      io.write(run.jobs[run.written], r);
      run.written++;
    }
  }

  private release(h: Helper): void {
    if (h.busy) this.clearTimer(h.busy.timer);
    h.busy = null;
  }
}
