import type { PipelineEvent, WorkerLike, WorkerOutbound, Unsubscribe } from '@calab/cala-runtime';

// Polling cadence for the dashboard's periodic dump (design §10). One
// pull per second is fast enough that the UI feels live and slow
// enough that the worker spends >99% of its time in the event bus.
export const DEFAULT_POLL_INTERVAL_MS = 1000;

// Maximum wait for a single archive-dump reply. Sized well above the
// polling cadence so transient worker-side stalls don't spuriously
// time out in normal operation.
export const DEFAULT_DUMP_TIMEOUT_MS = 5000;

export interface ArchiveDump {
  events: PipelineEvent[];
  metrics: Record<string, number>;
}

export interface TimeseriesReply {
  name: string;
  l1Times: Float32Array;
  l1Values: Float32Array;
  l2Times: Float32Array;
  l2Values: Float32Array;
}

export interface FootprintHistoryEntry {
  t: number;
  pixelIndices: Uint32Array;
  values: Float32Array;
}

export interface ArchiveClient {
  requestDump(): Promise<ArchiveDump>;
  requestTimeseries(name: string): Promise<TimeseriesReply>;
  requestEventsForNeuron(neuronId: number): Promise<PipelineEvent[]>;
  requestFootprintHistory(neuronId: number): Promise<FootprintHistoryEntry[]>;
  startPolling(cb: (dump: ArchiveDump) => void): void;
  stopPolling(): void;
  onEvent(cb: (e: PipelineEvent) => void): Unsubscribe;
  dispose(): void;
}

export interface ArchiveClientOptions {
  pollIntervalMs?: number;
  dumpTimeoutMs?: number;
}

class DumpAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DumpAbortError';
  }
}

class DumpTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DumpTimeoutError';
  }
}

// Generic reply binder. Every request kind shares the same
// "post-then-await-matching-requestId" pattern; this type lets us
// bookkeep them all in one pending map without losing type info at
// the resolve site.
interface PendingReply<T> {
  resolve: (v: T) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  kind: 'dump' | 'timeseries' | 'events-for-neuron' | 'footprint-history';
}

type PendingEntry =
  | PendingReply<ArchiveDump>
  | PendingReply<TimeseriesReply>
  | PendingReply<PipelineEvent[]>
  | PendingReply<FootprintHistoryEntry[]>;

export function createArchiveClient(
  worker: WorkerLike,
  options: ArchiveClientOptions = {},
): ArchiveClient {
  const pollInterval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const dumpTimeout = options.dumpTimeoutMs ?? DEFAULT_DUMP_TIMEOUT_MS;

  const pending = new Map<number, PendingEntry>();
  const eventListeners = new Set<(e: PipelineEvent) => void>();
  let nextRequestId = 1;
  let disposed = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let pollCallback: ((dump: ArchiveDump) => void) | null = null;

  const handleMessage = (ev: { data: WorkerOutbound }): void => {
    const msg = ev.data;
    switch (msg.kind) {
      case 'archive-dump': {
        const entry = pending.get(msg.requestId);
        // Unknown-id replies (e.g. from a disposed-and-recreated
        // client sharing the worker) must not spuriously resolve a
        // waiter. Same guard applies for every kind below.
        if (!entry || entry.kind !== 'dump') return;
        pending.delete(msg.requestId);
        clearTimeout(entry.timer);
        (entry as PendingReply<ArchiveDump>).resolve({
          events: msg.events,
          metrics: msg.metrics,
        });
        return;
      }
      case 'timeseries': {
        const entry = pending.get(msg.requestId);
        if (!entry || entry.kind !== 'timeseries') return;
        pending.delete(msg.requestId);
        clearTimeout(entry.timer);
        (entry as PendingReply<TimeseriesReply>).resolve({
          name: msg.name,
          l1Times: msg.l1Times,
          l1Values: msg.l1Values,
          l2Times: msg.l2Times,
          l2Values: msg.l2Values,
        });
        return;
      }
      case 'events-for-neuron': {
        const entry = pending.get(msg.requestId);
        if (!entry || entry.kind !== 'events-for-neuron') return;
        pending.delete(msg.requestId);
        clearTimeout(entry.timer);
        (entry as PendingReply<PipelineEvent[]>).resolve(msg.events);
        return;
      }
      case 'footprint-history': {
        const entry = pending.get(msg.requestId);
        if (!entry || entry.kind !== 'footprint-history') return;
        pending.delete(msg.requestId);
        clearTimeout(entry.timer);
        const history: FootprintHistoryEntry[] = [];
        for (let i = 0; i < msg.times.length; i += 1) {
          history.push({
            t: msg.times[i],
            pixelIndices: msg.pixelIndices[i],
            values: msg.values[i],
          });
        }
        (entry as PendingReply<FootprintHistoryEntry[]>).resolve(history);
        return;
      }
      case 'event':
        for (const cb of eventListeners) cb(msg.event);
        return;
      default:
        return;
    }
  };

  worker.addEventListener('message', handleMessage);

  function issueRequest<T>(
    kind: PendingEntry['kind'],
    label: string,
    send: (requestId: number) => void,
  ): Promise<T> {
    if (disposed) {
      return Promise.reject(new DumpAbortError('archive client disposed'));
    }
    const requestId = nextRequestId;
    nextRequestId += 1;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(
          new DumpTimeoutError(
            `archive ${label} (requestId=${requestId}) timed out after ${dumpTimeout}ms`,
          ),
        );
      }, dumpTimeout);
      pending.set(requestId, {
        kind,
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      } as unknown as PendingEntry);
      send(requestId);
    });
  }

  function requestDump(): Promise<ArchiveDump> {
    return issueRequest<ArchiveDump>('dump', 'dump', (requestId) => {
      worker.postMessage({ kind: 'request-archive-dump', requestId });
    });
  }

  function requestTimeseries(name: string): Promise<TimeseriesReply> {
    return issueRequest<TimeseriesReply>('timeseries', `timeseries(${name})`, (requestId) => {
      worker.postMessage({ kind: 'request-timeseries', requestId, name });
    });
  }

  function requestEventsForNeuron(neuronId: number): Promise<PipelineEvent[]> {
    return issueRequest<PipelineEvent[]>(
      'events-for-neuron',
      `events-for-neuron(${neuronId})`,
      (requestId) => {
        worker.postMessage({ kind: 'request-events-for-neuron', requestId, neuronId });
      },
    );
  }

  function requestFootprintHistory(neuronId: number): Promise<FootprintHistoryEntry[]> {
    return issueRequest<FootprintHistoryEntry[]>(
      'footprint-history',
      `footprint-history(${neuronId})`,
      (requestId) => {
        worker.postMessage({ kind: 'request-footprint-history', requestId, neuronId });
      },
    );
  }

  function startPolling(cb: (dump: ArchiveDump) => void): void {
    if (disposed) return;
    pollCallback = cb;
    const tick = (): void => {
      if (disposed || pollCallback === null) return;
      requestDump()
        .then((dump) => {
          if (!disposed && pollCallback !== null) pollCallback(dump);
        })
        .catch(() => {
          // Polling soft-fails per design §10 — dashboard is cosmetic.
          // A miss at one tick is recovered by the next.
        })
        .finally(() => {
          if (disposed || pollCallback === null) return;
          pollTimer = setTimeout(tick, pollInterval);
        });
    };
    // Fire-immediately-then-interval: the dashboard feels live from
    // the moment the run starts rather than waiting one full period.
    pollTimer = setTimeout(tick, 0);
  }

  function stopPolling(): void {
    pollCallback = null;
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  function onEvent(cb: (e: PipelineEvent) => void): Unsubscribe {
    eventListeners.add(cb);
    return () => {
      eventListeners.delete(cb);
    };
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    stopPolling();
    worker.removeEventListener('message', handleMessage);
    eventListeners.clear();
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new DumpAbortError('archive client disposed'));
    }
    pending.clear();
  }

  return {
    requestDump,
    requestTimeseries,
    requestEventsForNeuron,
    requestFootprintHistory,
    startPolling,
    stopPolling,
    onEvent,
    dispose,
  };
}
