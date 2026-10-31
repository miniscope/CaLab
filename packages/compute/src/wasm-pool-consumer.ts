// TileConsumer backed by an existing WorkerPool (the per-cell Rust/WASM path).
// A tile becomes one pool job per cell; the tile completes when every cell's
// job has completed. The app supplies `buildJob`, which turns one cell of a
// tile into its own pool job type (the worker protocol stays app-specific).

import type { BaseJob, WorkerPool } from './worker-pool.ts';
import type {
  BackendCalibration,
  ConsumerContext,
  SolveTile,
  TileCellResult,
  TileCellUpdate,
  TileConsumer,
} from './solve-tiles.ts';

/** Callbacks for one cell's pool job, already routed back into its tile. */
export interface CellJobCallbacks {
  onIntermediate(update: Omit<TileCellUpdate, 'cellIndex'>): void;
  onComplete(result: Omit<TileCellResult, 'cellIndex'>): void;
  onCancelled(): void;
  onError(message: string): void;
}

export interface WasmPoolConsumerOptions<TJob extends BaseJob> {
  pool: WorkerPool<TJob>;
  /** Build the pool job for cell `cellOffset` of `tile`, wiring `callbacks` into it. */
  buildJob(tile: SolveTile, cellOffset: number, jobId: number, callbacks: CellJobCallbacks): TJob;
  /**
   * Tiles in flight at once. Default: Infinity, i.e. hand everything to the
   * pool and let its own priority queue order the work (CaTune's behavior).
   * Set a finite value when other consumers share the queue, so the pool does
   * not hoard tiles they could run (see tile-scheduler.ts: `anyAccepting`
   * plus a finite maxInFlight is the configuration for running the pool and
   * the GPU together).
   */
  maxInFlight?: number;
  name?: string;
}

export function createWasmPoolConsumer<TJob extends BaseJob>(
  options: WasmPoolConsumerOptions<TJob>,
): TileConsumer {
  const { pool, buildJob } = options;
  const maxInFlight = options.maxInFlight ?? Infinity;
  /** tileId -> job ids of its cells still running */
  const running = new Map<number, number[]>();
  let jobCounter = 0;
  let ctx: ConsumerContext | null = null;
  const name = options.name ?? 'wasm-pool';

  function start(tile: SolveTile): void {
    const n = tile.cells.length;
    const results: (TileCellResult | null)[] = new Array(n).fill(null);
    const jobIds: number[] = [];
    let remaining = n;
    let settled = false;
    const done = () => {
      running.delete(tile.id);
      ctx?.ready();
    };
    const abort = (fn: () => void) => {
      if (settled) return;
      settled = true;
      for (const id of jobIds) pool.cancel(id);
      done();
      fn();
    };
    running.set(tile.id, jobIds);
    for (let k = 0; k < n && !settled; k++) {
      const cellIndex = tile.cells[k];
      const jobId = ++jobCounter;
      jobIds.push(jobId);
      const job = buildJob(tile, k, jobId, {
        onIntermediate(u) {
          if (!settled) tile.onIntermediate([{ ...u, cellIndex }]);
        },
        onComplete(r) {
          if (settled) return;
          results[k] = { backend: name, ...r, cellIndex };
          if (--remaining === 0) {
            settled = true;
            done();
            tile.onComplete(results as TileCellResult[]);
          }
        },
        onCancelled() {
          abort(() => tile.onCancelled());
        },
        onError(message) {
          abort(() => tile.onError(message));
        },
      });
      pool.dispatch(job);
    }
  }

  return {
    name,
    attach(context) {
      ctx = context;
    },
    accepts: () => null,
    take(offered, context) {
      ctx = context;
      const room = Math.max(0, maxInFlight - running.size);
      const taken = offered.slice(0, room);
      for (const t of taken) start(t);
      return taken;
    },
    cancel(tileId) {
      const ids = running.get(tileId);
      if (ids) for (const id of ids) pool.cancel(id);
    },
    calibration(): BackendCalibration | null {
      return null;
    },
    dispose() {
      pool.dispose();
    },
  };
}
