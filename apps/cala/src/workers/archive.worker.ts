/**
 * W4 — archive worker (design §9, §10).
 *
 * Subscribes to the pipeline event bus, maintains:
 *
 *  1. A rolling drop-oldest ring of raw `PipelineEvent`s (for the
 *     dashboard event feed + export). Capacity-bounded per §9.2.
 *  2. A per-name metric snapshot — the latest value for each
 *     `{kind:'metric', name, value}` stream. §9.1 describes the full
 *     tiered timeseries; this stub ships the "latest value" surface
 *     the task 24 dashboard needs, and keeps the door open for
 *     per-name ring buffers without changing the public reply shape.
 *
 * The worker does not compute — it only stores and answers queries.
 *
 * Event transport: the orchestrator forwards every fit-emitted
 * `PipelineEvent` via the `{ kind: 'event', event }` inbound variant
 * (worker-protocol.ts). We fan those out through a local `EventBus`
 * so the log-append callback and the metric-snapshot callback each
 * subscribe independently — matching the "bus consumer" model in
 * design §9.2 and making future additional subscribers a one-liner.
 */

import {
  EventBus,
  type PipelineEvent,
  type WorkerInbound,
  type WorkerInitPayload,
  type WorkerOutbound,
} from '@calab/cala-runtime';
import { TimeseriesStore } from './timeseries-store.ts';
import { NeuronEventIndex } from './neuron-event-index.ts';
import { FootprintHistoryStore } from './footprint-history-store.ts';

// Rolling event log capacity. Design §9.2 sizes ~500 structural
// events per typical session at ~2 KB each → ~1 MB budget; we default
// generously but tuneable via `workerConfig.eventRingCapacity`.
const DEFAULT_EVENT_RING_CAPACITY = 4096;
// Metric-snapshot entry cap. Bounds the per-name map so a misbehaving
// upstream cannot balloon memory. Overridable via
// `workerConfig.metricWindow`.
const DEFAULT_METRIC_WINDOW = 256;
// Tiered timeseries sizing (design §9.1). L1 holds the most recent
// `l1Capacity` samples at full resolution; L2 holds `l2Capacity`
// samples downsampled in blocks of `l2Stride` (so L2 covers up to
// `l2Capacity * l2Stride` historical samples). Defaults sized so
// one-vitals-per-frame at 30 fps keeps ~8.5 s at full resolution and
// ~17 min of older context at ~1 Hz, well within the §9 memory
// budget.
const DEFAULT_TS_L1_CAPACITY = 256;
const DEFAULT_TS_L2_CAPACITY = 1024;
const DEFAULT_TS_L2_STRIDE = 16;
// Per-neuron event index bounds (design §9.2). A typical session has
// ~500 structural events across ~100 neurons; 64 events per neuron
// covers the long tail while capping the per-id list so a rogue
// churn loop can't balloon memory.
const DEFAULT_NEURON_EVENT_LIMIT = 64;
const DEFAULT_MAX_INDEXED_NEURONS = 1024;
// Footprint history sizing (design §9.3). 32 per-neuron snapshots
// covers the log-spaced schedule's ~16 floor entries plus a comparable
// number of change-triggered snapshots; 512 distinct neurons matches
// the §9.3 12h-session budget of ~5 MB at ~4 KB per sparse footprint.
const DEFAULT_FOOTPRINT_HISTORY_LIMIT = 32;
const DEFAULT_FOOTPRINT_HISTORY_MAX_NEURONS = 512;
// Local EventBus sizing. Archive is the sole subscriber post-init and
// drains synchronously, so these are effectively no-backpressure
// defaults — but they live in config per the no-magic-numbers rule.
const DEFAULT_LOCAL_BUS_CAPACITY = 64;
// One subscriber per archive sink: event ring, latest-value metric
// snapshot, tiered timeseries, per-neuron index, footprint history,
// plus headroom for future additions (§9.2 "bus consumer" model).
const DEFAULT_LOCAL_BUS_MAX_SUBSCRIBERS = 8;

const ROLE = 'archive' as const;

interface WorkerGlobalScope {
  postMessage(msg: WorkerOutbound): void;
  onmessage: ((ev: MessageEvent<WorkerInbound>) => void) | null;
}

interface ArchiveWorkerConfig {
  eventRingCapacity: number;
  metricWindow: number;
  localBusCapacity: number;
  localBusMaxSubscribers: number;
  timeseriesL1Capacity: number;
  timeseriesL2Capacity: number;
  timeseriesL2Stride: number;
  neuronEventLimit: number;
  maxIndexedNeurons: number;
  footprintHistoryLimit: number;
  footprintHistoryMaxNeurons: number;
}

const workerSelf = ((globalThis as unknown as { self?: WorkerGlobalScope }).self ??
  (globalThis as unknown as WorkerGlobalScope)) as WorkerGlobalScope;

interface RuntimeHandles {
  cfg: ArchiveWorkerConfig;
  bus: EventBus;
  unsubscribeLog: () => void;
  unsubscribeMetrics: () => void;
  // Drop-oldest ring. Array-backed because `PipelineEvent` carries
  // typed-array payloads that we keep by reference — flattening into a
  // single `Uint8Array` would force serialization the dashboard does
  // not need.
  eventLog: PipelineEvent[];
  metricSnapshot: Map<string, number>;
  timeseries: TimeseriesStore;
  unsubscribeTimeseries: () => void;
  neuronIndex: NeuronEventIndex;
  unsubscribeNeuronIndex: () => void;
  footprints: FootprintHistoryStore;
  unsubscribeFootprints: () => void;
  running: boolean;
  stopped: boolean;
}

let handles: RuntimeHandles | null = null;
let donePosted = false;

function post(msg: WorkerOutbound): void {
  workerSelf.postMessage(msg);
}

function postError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  post({ kind: 'error', role: ROLE, message });
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function parseConfig(raw: unknown): ArchiveWorkerConfig {
  const cfg = asRecord(raw);
  const pickPositiveInt = (key: string, fallback: number): number => {
    const v = cfg[key];
    return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : fallback;
  };
  return {
    eventRingCapacity: pickPositiveInt('eventRingCapacity', DEFAULT_EVENT_RING_CAPACITY),
    metricWindow: pickPositiveInt('metricWindow', DEFAULT_METRIC_WINDOW),
    localBusCapacity: pickPositiveInt('localBusCapacity', DEFAULT_LOCAL_BUS_CAPACITY),
    localBusMaxSubscribers: pickPositiveInt(
      'localBusMaxSubscribers',
      DEFAULT_LOCAL_BUS_MAX_SUBSCRIBERS,
    ),
    timeseriesL1Capacity: pickPositiveInt('timeseriesL1Capacity', DEFAULT_TS_L1_CAPACITY),
    timeseriesL2Capacity: pickPositiveInt('timeseriesL2Capacity', DEFAULT_TS_L2_CAPACITY),
    timeseriesL2Stride: pickPositiveInt('timeseriesL2Stride', DEFAULT_TS_L2_STRIDE),
    neuronEventLimit: pickPositiveInt('neuronEventLimit', DEFAULT_NEURON_EVENT_LIMIT),
    maxIndexedNeurons: pickPositiveInt('maxIndexedNeurons', DEFAULT_MAX_INDEXED_NEURONS),
    footprintHistoryLimit: pickPositiveInt(
      'footprintHistoryLimit',
      DEFAULT_FOOTPRINT_HISTORY_LIMIT,
    ),
    footprintHistoryMaxNeurons: pickPositiveInt(
      'footprintHistoryMaxNeurons',
      DEFAULT_FOOTPRINT_HISTORY_MAX_NEURONS,
    ),
  };
}

function handleInit(payload: WorkerInitPayload): void {
  const cfg = parseConfig(payload.workerConfig);
  const bus = new EventBus({
    capacity: cfg.localBusCapacity,
    maxSubscribers: cfg.localBusMaxSubscribers,
  });
  const eventLog: PipelineEvent[] = [];
  const metricSnapshot = new Map<string, number>();
  const timeseries = new TimeseriesStore({
    l1Capacity: cfg.timeseriesL1Capacity,
    l2Capacity: cfg.timeseriesL2Capacity,
    l2Stride: cfg.timeseriesL2Stride,
    maxNames: cfg.metricWindow,
  });
  const neuronIndex = new NeuronEventIndex({
    maxNeurons: cfg.maxIndexedNeurons,
    perNeuronLimit: cfg.neuronEventLimit,
  });
  const footprints = new FootprintHistoryStore({
    perNeuronLimit: cfg.footprintHistoryLimit,
    maxNeurons: cfg.footprintHistoryMaxNeurons,
  });

  const unsubscribeLog = bus.subscribe((e) => {
    if (eventLog.length === cfg.eventRingCapacity) {
      eventLog.shift();
    }
    eventLog.push(e);
  });

  const unsubscribeMetrics = bus.subscribe((e) => {
    if (e.kind !== 'metric') return;
    // Last-writer-wins on name. When we exceed the metric window, we
    // drop the *oldest-inserted* name — Map iteration order gives us
    // insertion order for free.
    if (!metricSnapshot.has(e.name) && metricSnapshot.size >= cfg.metricWindow) {
      const oldest = metricSnapshot.keys().next().value;
      if (oldest !== undefined) metricSnapshot.delete(oldest);
    }
    metricSnapshot.set(e.name, e.value);
  });

  const unsubscribeTimeseries = bus.subscribe((e) => {
    if (e.kind !== 'metric') return;
    timeseries.append(e.name, e.t, e.value);
  });

  const unsubscribeNeuronIndex = bus.subscribe((e) => {
    neuronIndex.record(e);
  });

  const unsubscribeFootprints = bus.subscribe((e) => {
    switch (e.kind) {
      case 'birth':
        footprints.record(e.id, e.t, e.footprintSnap);
        return;
      case 'merge':
        // Footprint belongs to the survivor — `into`.
        footprints.record(e.into, e.t, e.footprintSnap);
        return;
      case 'split':
        // Each child gets its own snap; ordering pairs `into[i]` with
        // `footprintSnaps[i]` per the PipelineEvent contract.
        for (let i = 0; i < e.into.length; i += 1) {
          const snap = e.footprintSnaps[i];
          if (snap) footprints.record(e.into[i], e.t, snap);
        }
        return;
      case 'footprint-snapshot':
        footprints.record(e.neuronId, e.t, e.footprint);
        return;
      case 'deprecate':
      case 'reject':
      case 'metric':
        return;
    }
  });

  handles = {
    cfg,
    bus,
    unsubscribeLog,
    unsubscribeMetrics,
    eventLog,
    metricSnapshot,
    timeseries,
    unsubscribeTimeseries,
    neuronIndex,
    unsubscribeNeuronIndex,
    footprints,
    unsubscribeFootprints,
    running: false,
    stopped: false,
  };
  post({ kind: 'ready', role: ROLE });
}

function handleEvent(event: PipelineEvent): void {
  if (!handles || handles.stopped) return;
  handles.bus.publish(event);
}

function handleDumpRequest(requestId: number): void {
  if (!handles) return;
  post({
    kind: 'archive-dump',
    role: ROLE,
    requestId,
    // Copy so the caller can't mutate archive-internal state via the
    // returned reference; the typed-array payloads inside each event
    // remain by-reference (same contract as EventBus subscribers).
    events: handles.eventLog.slice(),
    metrics: Object.fromEntries(handles.metricSnapshot),
  });
}

function handleTimeseriesRequest(requestId: number, name: string): void {
  if (!handles) return;
  const q = handles.timeseries.query(name);
  post({
    kind: 'timeseries',
    role: ROLE,
    requestId,
    name,
    l1Times: q.l1Times,
    l1Values: q.l1Values,
    l2Times: q.l2Times,
    l2Values: q.l2Values,
  });
}

function handleNeuronEventsRequest(requestId: number, neuronId: number): void {
  if (!handles) return;
  post({
    kind: 'events-for-neuron',
    role: ROLE,
    requestId,
    neuronId,
    events: handles.neuronIndex.query(neuronId),
  });
}

function handleFootprintHistoryRequest(requestId: number, neuronId: number): void {
  if (!handles) return;
  const history = handles.footprints.query(neuronId);
  const times = new Float32Array(history.length);
  const pixelIndices: Uint32Array[] = [];
  const values: Float32Array[] = [];
  for (let i = 0; i < history.length; i += 1) {
    times[i] = history[i].t;
    pixelIndices.push(history[i].pixelIndices);
    values.push(history[i].values);
  }
  post({
    kind: 'footprint-history',
    role: ROLE,
    requestId,
    neuronId,
    times,
    pixelIndices,
    values,
  });
}

function postDoneOnce(): void {
  if (donePosted) return;
  donePosted = true;
  post({ kind: 'done', role: ROLE });
}

function handleStop(): void {
  if (!handles) {
    postDoneOnce();
    return;
  }
  handles.stopped = true;
  handles.unsubscribeLog();
  handles.unsubscribeMetrics();
  handles.unsubscribeTimeseries();
  handles.unsubscribeNeuronIndex();
  handles.unsubscribeFootprints();
  handles.bus.close();
  postDoneOnce();
}

workerSelf.onmessage = (ev: MessageEvent<WorkerInbound>): void => {
  const msg = ev.data;
  switch (msg.kind) {
    case 'init':
      try {
        handleInit(msg.payload);
      } catch (err) {
        postError(err);
      }
      return;
    case 'run':
      if (handles) handles.running = true;
      return;
    case 'event':
      handleEvent(msg.event);
      return;
    case 'request-archive-dump':
      handleDumpRequest(msg.requestId);
      return;
    case 'request-timeseries':
      handleTimeseriesRequest(msg.requestId, msg.name);
      return;
    case 'request-events-for-neuron':
      handleNeuronEventsRequest(msg.requestId, msg.neuronId);
      return;
    case 'request-footprint-history':
      handleFootprintHistoryRequest(msg.requestId, msg.neuronId);
      return;
    case 'stop':
      handleStop();
      return;
    case 'snapshot-ack':
      // Archive does not participate in the snapshot protocol.
      return;
  }
};
