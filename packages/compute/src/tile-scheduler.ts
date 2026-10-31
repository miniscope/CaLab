// Tile work queue: producers submit SolveTiles, registered TileConsumers pull
// them. See solve-tiles.ts for the types.
//
// - Pumping is deferred to a microtask, so a producer that submits many tiles
//   in one synchronous loop (CaTune's per-cell dispatch) has them all offered
//   together; a batch consumer can take them as one batch.
// - Each pump offers every consumer, in registration order, the waiting tiles
//   the assignment policy allows it, sorted by priority.
// - The scheduler wraps each tile's callbacks: a tile settles exactly once,
//   and callbacks from a consumer that no longer owns the tile (cancelled, or
//   re-queued after the consumer failed) are dropped.
// - A consumer that reports failure is removed; its unsettled tiles go back
//   to the queue (unchanged, with their original warm start) for the
//   remaining consumers.

import type {
  ConsumerContext,
  SolveTile,
  TileAssignPolicy,
  TileCellResult,
  TileCellUpdate,
  TileConsumer,
} from './solve-tiles.ts';

export interface TileSchedulerOptions {
  consumers: TileConsumer[];
  /** Default: `preferFirstAccepting` (a single consumer per tile, by preference order). */
  assign?: TileAssignPolicy;
  /** A consumer failed and was removed. */
  onConsumerFailed?(consumer: TileConsumer, reason: string): void;
  /** A consumer declined a tile it was preferred for (e.g. GPU and FFT conv mode). */
  onSkipped?(tile: SolveTile, consumer: TileConsumer, reason: string): void;
}

export interface TileScheduler {
  submit(tile: SolveTile): void;
  cancel(tileId: number): void;
  cancelAll(): void;
  readonly consumers: readonly TileConsumer[];
  /** Register a consumer; `index` sets its preference position (default: last). */
  addConsumer(consumer: TileConsumer, index?: number): void;
  /** Unregister a consumer: its unsettled tiles are re-queued and it is disposed. */
  removeConsumer(consumer: TileConsumer): void;
  /** Number of tiles waiting for a consumer. */
  readonly waiting: number;
  dispose(): void;
}

/**
 * Default policy: the tile goes to the first consumer that accepts it, and
 * waits for that consumer even while later consumers are idle. Consumers
 * before it that declined are reported as skipped.
 */
export const preferFirstAccepting: TileAssignPolicy = (tile, consumers) => {
  const skipped: { consumer: TileConsumer; reason: string }[] = [];
  for (const c of consumers) {
    const reason = c.accepts(tile);
    if (reason === null) return { eligible: [c], skipped };
    skipped.push({ consumer: c, reason });
  }
  return { eligible: [], skipped };
};

/** Policy that lets every accepting consumer take the tile (whoever pulls first). */
export const anyAccepting: TileAssignPolicy = (tile, consumers) => {
  const eligible: TileConsumer[] = [];
  const skipped: { consumer: TileConsumer; reason: string }[] = [];
  for (const c of consumers) {
    const reason = c.accepts(tile);
    if (reason === null) eligible.push(c);
    else skipped.push({ consumer: c, reason });
  }
  return { eligible, skipped };
};

interface Entry {
  tile: SolveTile;
  owner: TileConsumer | null;
  /** Bumped when the tile is re-queued, so callbacks from a previous owner are dropped. */
  generation: number;
  settled: boolean;
}

export function createTileScheduler(options: TileSchedulerOptions): TileScheduler {
  const consumers = [...options.consumers];
  const assign = options.assign ?? preferFirstAccepting;
  const entries = new Map<number, Entry>();
  const waiting: Entry[] = [];
  let pumpScheduled = false;
  let pumping = false;
  let disposed = false;

  const contexts = new Map<TileConsumer, ConsumerContext>();
  for (const c of consumers) contexts.set(c, makeContext(c));

  function makeContext(consumer: TileConsumer): ConsumerContext {
    return {
      ready: schedulePump,
      failed: (reason) => failConsumer(consumer, reason),
      hasWaiting: () => waiting.some((e) => assign(e.tile, consumers).eligible.includes(consumer)),
      giveBack: (ids) => {
        for (const id of ids) {
          const e = entries.get(id);
          if (e && !e.settled && e.owner === consumer) requeue(e);
        }
        schedulePump();
      },
    };
  }

  function settle(entry: Entry): void {
    entry.settled = true;
    entries.delete(entry.tile.id);
  }

  /** A fresh view of the tile for one hand-out; its callbacks die if the tile is re-queued. */
  function handOut(entry: Entry): SolveTile {
    const t = entry.tile;
    const gen = entry.generation;
    const live = () => !entry.settled && entry.generation === gen && !disposed;
    const finish = (fn: () => void) => {
      if (!live()) return;
      settle(entry);
      fn();
      schedulePump();
    };
    return {
      id: t.id,
      cells: t.cells,
      windowStart: t.windowStart,
      traces: t.traces,
      params: t.params,
      warmStart: t.warmStart,
      maxIterations: t.maxIterations,
      getPriority: t.getPriority ? () => t.getPriority!() : undefined,
      wantsIntermediate: t.wantsIntermediate ? () => t.wantsIntermediate!() : undefined,
      onIntermediate: (updates: TileCellUpdate[]) => {
        if (live()) t.onIntermediate(updates);
      },
      onComplete: (results: TileCellResult[]) => finish(() => t.onComplete(results)),
      onCancelled: () => finish(() => t.onCancelled()),
      onError: (message: string) => finish(() => t.onError(message)),
    };
  }

  function priority(e: Entry): number {
    return e.tile.getPriority?.() ?? 1;
  }

  function schedulePump(): void {
    if (pumpScheduled || disposed) return;
    pumpScheduled = true;
    queueMicrotask(() => {
      pumpScheduled = false;
      pump();
    });
  }

  function pump(): void {
    if (disposed || pumping) return;
    pumping = true;
    try {
      const routes = new Map<Entry, ReturnType<TileAssignPolicy>>();
      // Tiles no consumer can take fail now.
      for (let i = waiting.length - 1; i >= 0; i--) {
        const e = waiting[i];
        const route = assign(e.tile, consumers);
        routes.set(e, route);
        if (route.eligible.length === 0) {
          waiting.splice(i, 1);
          settle(e);
          const why = route.skipped.map((s) => `${s.consumer.name}: ${s.reason}`).join('; ');
          e.tile.onError(
            why ? `No solver backend can run this tile (${why})` : 'No solver backend',
          );
        }
      }
      if (waiting.length > 1) waiting.sort((a, b) => priority(a) - priority(b));

      for (const consumer of [...consumers]) {
        if (waiting.length === 0) break;
        const offered = waiting.filter((e) => routes.get(e)?.eligible.includes(consumer));
        if (offered.length === 0) continue;
        const byId = new Map(offered.map((e) => [e.tile.id, e]));
        const taken = consumer.take(offered.map(handOut), contexts.get(consumer)!);
        if (!consumers.includes(consumer)) continue; // failed synchronously inside take()
        for (const t of taken) {
          const e = byId.get(t.id);
          if (!e) continue;
          e.owner = consumer;
          const w = waiting.indexOf(e);
          if (w !== -1) waiting.splice(w, 1);
          for (const s of routes.get(e)!.skipped) options.onSkipped?.(e.tile, s.consumer, s.reason);
        }
      }
    } finally {
      pumping = false;
    }
  }

  function requeue(e: Entry): void {
    e.owner = null;
    e.generation++; // drops the previous owner's late callbacks
    waiting.push(e);
  }

  /** Remove a consumer and re-queue its unsettled tiles. False if it was not registered. */
  function detach(consumer: TileConsumer): boolean {
    const idx = consumers.indexOf(consumer);
    if (idx === -1 || disposed) return false;
    consumers.splice(idx, 1);
    contexts.delete(consumer);
    for (const e of entries.values()) {
      if (e.owner === consumer && !e.settled) requeue(e);
    }
    try {
      consumer.dispose();
    } catch (err) {
      console.warn(`[tile-scheduler] disposing ${consumer.name} failed:`, err);
    }
    return true;
  }

  function failConsumer(consumer: TileConsumer, reason: string): void {
    if (!detach(consumer)) return;
    options.onConsumerFailed?.(consumer, reason);
    schedulePump();
  }

  function addConsumer(consumer: TileConsumer, index = consumers.length): void {
    if (disposed || consumers.includes(consumer)) return;
    consumers.splice(Math.max(0, Math.min(index, consumers.length)), 0, consumer);
    contexts.set(consumer, makeContext(consumer));
    schedulePump();
  }

  function removeConsumer(consumer: TileConsumer): void {
    if (detach(consumer)) schedulePump();
  }

  function submit(tile: SolveTile): void {
    if (disposed) {
      tile.onCancelled();
      return;
    }
    const entry: Entry = { tile, owner: null, generation: 0, settled: false };
    entries.set(tile.id, entry);
    waiting.push(entry);
    schedulePump();
  }

  function cancel(tileId: number): void {
    const entry = entries.get(tileId);
    if (!entry || entry.settled) return;
    const wIdx = waiting.indexOf(entry);
    if (wIdx !== -1) {
      waiting.splice(wIdx, 1);
      settle(entry);
      entry.tile.onCancelled();
      return;
    }
    entry.owner?.cancel(tileId);
  }

  function cancelAll(): void {
    for (const id of [...entries.keys()]) cancel(id);
  }

  function dispose(): void {
    if (disposed) return;
    const pending = [...entries.values()].filter((e) => !e.settled);
    disposed = true;
    entries.clear();
    waiting.length = 0;
    for (const c of consumers) c.dispose();
    consumers.length = 0;
    for (const e of pending) {
      e.settled = true;
      e.tile.onCancelled();
    }
  }

  return {
    submit,
    cancel,
    cancelAll,
    get consumers() {
      return consumers;
    },
    addConsumer,
    removeConsumer,
    get waiting() {
      return waiting.length;
    },
    dispose,
  };
}
