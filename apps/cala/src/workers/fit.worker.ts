import {
  initCalaCore,
  Extender,
  Fitter,
  MutationQueueHandle,
  calaMemoryBytes,
} from '@calab/cala-core';
import {
  METRIC_CELL_COUNT,
  METRIC_EXTEND_QUEUE_DEPTH,
  METRIC_FPS,
  METRIC_MEMORY_BYTES,
  METRIC_RESIDUAL_L2,
} from '../lib/vitals.ts';
import { FootprintSnapshotScheduler } from './footprint-snapshot-scheduler.ts';
import {
  SabRingChannel,
  EventBus,
  SnapshotProtocol,
  MutationQueue,
  type ChannelConfig,
  type PipelineEvent,
  type PipelineMutation,
  type WorkerInbound,
  type WorkerInitPayload,
  type WorkerOutbound,
} from '@calab/cala-runtime';

// Heartbeat cadence: post a `frame-processed` beat every N fit steps.
// Mirrors W1's DEFAULT_HEARTBEAT_STRIDE so the orchestrator sees
// equal-frequency beats from both sides of the frame channel.
// Overridable via `workerConfig.heartbeatStride` (design §7.1).
const DEFAULT_HEARTBEAT_STRIDE = 8;
// Snapshot cadence: fit takes a COW snapshot every N frames so the
// extend worker has a consistent view of `(Ã, W, M, epoch)` to work
// against (design §7.2). 16 frames ≈ half-second at 30 fps — fresh
// enough for extend's tens-of-frames-per-cycle, infrequent enough to
// keep fit's hot path free of per-frame `takeSnapshot()` cost.
const DEFAULT_SNAPSHOT_STRIDE = 16;
// Upper bound on mutations drained per loop iteration. The underlying
// WASM `drainApply` already pulls everything, but we re-queue any
// oversubscribed work so a runaway extend burst can't stall fit for
// more than one frame. Matches `DEFAULT_PROPOSALS_PER_CYCLE_MAX` in
// `crate::config` (design §13 dense-scene risk mitigation).
const DEFAULT_MUTATION_DRAIN_MAX_PER_ITERATION = 4;
// Event bus capacity for the in-worker publisher. Matches the
// archive-worker expectation from §9.2: 2 KB per event × 16 events is
// one cycle of headroom; real backpressure lives in the SAB transport
// that replaces this in later tasks.
const DEFAULT_EVENT_BUS_CAPACITY = 256;
const DEFAULT_EVENT_BUS_MAX_SUBSCRIBERS = 4;
// Snapshot protocol defaults for the in-worker stand-in. These mirror
// the orchestrator-side defaults — swap to the SAB transport later
// keeps the same knob names.
const DEFAULT_SNAPSHOT_ACK_TIMEOUT_MS = 500;
const DEFAULT_SNAPSHOT_POLL_INTERVAL_MS = 2;
const DEFAULT_SNAPSHOT_PENDING_CAPACITY = 1;
const DEFAULT_FRAME_CHANNEL_WAIT_TIMEOUT_MS = 1000;
const DEFAULT_FRAME_CHANNEL_POLL_INTERVAL_MS = 1;
const FRAME_CHANNEL_SLOT_COUNT_FALLBACK = 4;
// Mutation queue capacity: mirrors `DEFAULT_MUTATION_QUEUE_CAPACITY`
// in `crate::config` (design §7.3, 32 slots, drop-oldest).
const DEFAULT_MUTATION_QUEUE_CAPACITY = 32;
const DEFAULT_FIT_CONFIG_JSON = '{}';
const DEFAULT_EXTEND_CONFIG_JSON = '{}';
// Vitals cadence (design §12 header bar). Emit every N steps so the
// sparkline widgets see smooth updates without per-frame postMessage
// cost. 8 aligns with `DEFAULT_HEARTBEAT_STRIDE` so one fit iteration
// either emits the full vitals bundle or none of it. Overridable
// via `workerConfig.vitalsStride`.
const DEFAULT_VITALS_STRIDE = 8;
// Cap on neurons tracked by the log-spaced footprint scheduler
// (design §9.3). Matches the archive's footprint-history neuron cap
// so upstream and storage stay within the same envelope.
const DEFAULT_FOOTPRINT_SCHEDULER_MAX_NEURONS = 512;
// Extend-cycle cadence (design §13 bounded-work-per-cycle). One
// cycle every N fit steps keeps segmentation cost amortized across
// the fit hot path; default 32 ≈ ~1 s at 30 fps. Overridable via
// `workerConfig.extendCycleStride`. Setting to 0 disables extend.
const DEFAULT_EXTEND_CYCLE_STRIDE = 32;
// Residual window the Extender keeps. Mirrors
// `ExtendConfig::extend_window_frames` but lives here so the caller
// can size the window independently from extend_cfg if needed.
const DEFAULT_EXTEND_WINDOW_FRAMES = 64;
// JSON for Extender-side recording metadata. Falls through to the
// fit worker's caller-supplied `metadataJson` via its own config
// path in task 5's shared vocabulary.
const DEFAULT_METADATA_JSON = '{}';

const ROLE = 'fit' as const;

interface WorkerGlobalScope {
  postMessage(msg: WorkerOutbound): void;
  onmessage: ((ev: MessageEvent<WorkerInbound>) => void) | null;
}

interface FitWorkerConfig {
  height: number;
  width: number;
  fitConfigJson: string;
  extendConfigJson: string;
  heartbeatStride: number;
  vitalsStride: number;
  snapshotStride: number;
  footprintSchedulerMaxNeurons: number;
  extendCycleStride: number;
  extendWindowFrames: number;
  metadataJson: string;
  mutationDrainMaxPerIteration: number;
  eventBusCapacity: number;
  eventBusMaxSubscribers: number;
  snapshotAckTimeoutMs: number;
  snapshotPollIntervalMs: number;
  snapshotPendingCapacity: number;
  mutationQueueCapacity: number;
  frameChannelSlotBytes?: number;
  frameChannelSlotCount: number;
  frameChannelWaitTimeoutMs: number;
  frameChannelPollIntervalMs: number;
}

// Route through `self` when present so `vi.stubGlobal('self', harness)`
// picks us up; falls back to `globalThis` in environments that don't
// alias them.
const workerSelf = ((globalThis as unknown as { self?: WorkerGlobalScope }).self ??
  (globalThis as unknown as WorkerGlobalScope)) as WorkerGlobalScope;

interface RuntimeHandles {
  fitter: Fitter;
  frameChannel: SabRingChannel;
  mutationQueue: MutationQueue;
  mutationQueueHandle: MutationQueueHandle;
  snapshotProtocol: SnapshotProtocol;
  eventBus: EventBus;
  eventSubscription: () => void;
  config: FitWorkerConfig;
  pixels: number;
  // Wall-clock at the previous vitals emission, used to derive fps
  // over the interval since the last post (not instantaneous, not
  // cumulative — just the rate the user perceives on the bar).
  lastVitalsTimeMs: number;
  // Frame index at the previous emission so (now - last) ÷ (framesNow
  // - framesLast) × 1000 gives fps without caring about stride edge
  // cases if the worker skipped a window on backpressure.
  lastVitalsFrameIndex: number;
  // Most recent residualL2 from `step()`; cached between frames so the
  // vitals emission can read it without re-running math.
  lastResidualL2: number;
  footprintScheduler: FootprintSnapshotScheduler;
  // Extend side (task 11). `null` when extendCycleStride is 0 —
  // W3's heartbeat still runs, but no real cycles fire. In the v1
  // architecture extend runs inside the fit worker because
  // `Extender::runCycle` needs `&Fitter`; a cross-worker snapshot
  // transport is Phase 7 work (design §7.2).
  extender: Extender | null;
}

let handles: RuntimeHandles | null = null;
let running = false;
let stopRequested = false;
let donePosted = false;
let loopPromise: Promise<void> | null = null;

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

function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function stringOr(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

function parseConfig(raw: unknown): FitWorkerConfig {
  const cfg = asRecord(raw);
  const height = numberOr(cfg.height, 0);
  const width = numberOr(cfg.width, 0);
  if (height <= 0 || width <= 0) {
    throw new Error('workerConfig.height and workerConfig.width must be positive');
  }
  return {
    height,
    width,
    fitConfigJson: stringOr(cfg.fitConfigJson, DEFAULT_FIT_CONFIG_JSON),
    extendConfigJson: stringOr(cfg.extendConfigJson, DEFAULT_EXTEND_CONFIG_JSON),
    heartbeatStride: numberOr(cfg.heartbeatStride, DEFAULT_HEARTBEAT_STRIDE),
    vitalsStride: numberOr(cfg.vitalsStride, DEFAULT_VITALS_STRIDE),
    snapshotStride: numberOr(cfg.snapshotStride, DEFAULT_SNAPSHOT_STRIDE),
    footprintSchedulerMaxNeurons: numberOr(
      cfg.footprintSchedulerMaxNeurons,
      DEFAULT_FOOTPRINT_SCHEDULER_MAX_NEURONS,
    ),
    extendCycleStride: numberOr(cfg.extendCycleStride, DEFAULT_EXTEND_CYCLE_STRIDE),
    extendWindowFrames: numberOr(cfg.extendWindowFrames, DEFAULT_EXTEND_WINDOW_FRAMES),
    metadataJson: stringOr(cfg.metadataJson, DEFAULT_METADATA_JSON),
    mutationDrainMaxPerIteration: numberOr(
      cfg.mutationDrainMaxPerIteration,
      DEFAULT_MUTATION_DRAIN_MAX_PER_ITERATION,
    ),
    eventBusCapacity: numberOr(cfg.eventBusCapacity, DEFAULT_EVENT_BUS_CAPACITY),
    eventBusMaxSubscribers: numberOr(cfg.eventBusMaxSubscribers, DEFAULT_EVENT_BUS_MAX_SUBSCRIBERS),
    snapshotAckTimeoutMs: numberOr(cfg.snapshotAckTimeoutMs, DEFAULT_SNAPSHOT_ACK_TIMEOUT_MS),
    snapshotPollIntervalMs: numberOr(cfg.snapshotPollIntervalMs, DEFAULT_SNAPSHOT_POLL_INTERVAL_MS),
    snapshotPendingCapacity: numberOr(
      cfg.snapshotPendingCapacity,
      DEFAULT_SNAPSHOT_PENDING_CAPACITY,
    ),
    mutationQueueCapacity: numberOr(cfg.mutationQueueCapacity, DEFAULT_MUTATION_QUEUE_CAPACITY),
    frameChannelSlotBytes:
      typeof cfg.frameChannelSlotBytes === 'number' ? cfg.frameChannelSlotBytes : undefined,
    frameChannelSlotCount: numberOr(cfg.frameChannelSlotCount, FRAME_CHANNEL_SLOT_COUNT_FALLBACK),
    frameChannelWaitTimeoutMs: numberOr(
      cfg.frameChannelWaitTimeoutMs,
      DEFAULT_FRAME_CHANNEL_WAIT_TIMEOUT_MS,
    ),
    frameChannelPollIntervalMs: numberOr(
      cfg.frameChannelPollIntervalMs,
      DEFAULT_FRAME_CHANNEL_POLL_INTERVAL_MS,
    ),
  };
}

async function handleInit(payload: WorkerInitPayload): Promise<void> {
  await initCalaCore();
  const cfg = parseConfig(payload.workerConfig);

  const pixels = cfg.height * cfg.width;
  const fitter = new Fitter(cfg.height, cfg.width, cfg.fitConfigJson);
  const mutationQueueHandle = new MutationQueueHandle(cfg.extendConfigJson);
  const mutationQueue = new MutationQueue({ capacity: cfg.mutationQueueCapacity });

  const channelCfg: ChannelConfig = {
    slotBytes: cfg.frameChannelSlotBytes ?? pixels * Float32Array.BYTES_PER_ELEMENT,
    slotCount: cfg.frameChannelSlotCount,
    waitTimeoutMs: cfg.frameChannelWaitTimeoutMs,
    pollIntervalMs: cfg.frameChannelPollIntervalMs,
    sharedBuffer: payload.frameChannelBuffer,
  };
  const frameChannel = new SabRingChannel(channelCfg);

  const snapshotProtocol = new SnapshotProtocol({
    ackTimeoutMs: cfg.snapshotAckTimeoutMs,
    pollIntervalMs: cfg.snapshotPollIntervalMs,
    pendingCapacity: cfg.snapshotPendingCapacity,
  });

  const eventBus = new EventBus({
    capacity: cfg.eventBusCapacity,
    maxSubscribers: cfg.eventBusMaxSubscribers,
  });
  // Forwarding subscription: every PipelineEvent published on the
  // in-worker bus is relayed across postMessage as a `'event'`
  // outbound. The SAB-backed transport in later tasks replaces this
  // `subscribe` bridge with a zero-copy ring without touching
  // numerics callers.
  const eventSubscription = eventBus.subscribe((event: PipelineEvent) => {
    post({ kind: 'event', role: ROLE, event });
  });

  handles = {
    fitter,
    frameChannel,
    mutationQueue,
    mutationQueueHandle,
    snapshotProtocol,
    eventBus,
    eventSubscription,
    config: cfg,
    pixels,
    lastVitalsTimeMs: 0,
    lastVitalsFrameIndex: 0,
    lastResidualL2: 0,
    footprintScheduler: new FootprintSnapshotScheduler({
      maxTrackedNeurons: cfg.footprintSchedulerMaxNeurons,
    }),
    extender:
      cfg.extendCycleStride > 0
        ? new Extender(
            cfg.height,
            cfg.width,
            cfg.extendWindowFrames,
            cfg.extendConfigJson,
            cfg.metadataJson,
          )
        : null,
  };

  // Test-only hook so unit tests can push mutations into the worker's
  // MutationQueue without standing up a full extend worker. Mirrors
  // the SAB-backed producer side of §7.3 — real extend worker pushes
  // via SAB, tests push via this handle. No production consumer reads
  // this field.
  (globalThis as { __calaFitHandles?: { mutationQueue: MutationQueue } }).__calaFitHandles = {
    mutationQueue,
  };

  post({ kind: 'ready', role: ROLE });
}

function readNextFrame(h: RuntimeHandles): Float32Array | null {
  const slot = h.frameChannel.readSlot();
  if (slot === null) return null;
  // Slot payload is u8; reinterpret as f32 without copy. Slot.data is
  // already an owned copy so we can alias it safely.
  return new Float32Array(slot.data.buffer, slot.data.byteOffset, h.pixels);
}

function mutationToEvent(m: PipelineMutation, frameIndex: number): PipelineEvent | null {
  // Translate each applied mutation into the structural event the
  // archive worker logs (§9.2). `register` → birth, `merge` → merge,
  // `deprecate` → deprecate. Reject / split / metric events come
  // from other sources (extend quality-gate fails, user overrides).
  switch (m.type) {
    case 'register':
      return {
        kind: 'birth',
        t: frameIndex,
        // Real id assignment happens inside fit's apply. Until the
        // WASM surface surfaces it (later task), report the
        // snapshot epoch as a stable per-mutation correlation id.
        id: Number(m.snapshotEpoch),
        patch: [0, 0],
        footprintSnap: { pixelIndices: m.support, values: m.values },
      };
    case 'merge':
      return {
        kind: 'merge',
        t: frameIndex,
        ids: [m.mergeIds[0], m.mergeIds[1]],
        into: m.mergeIds[0],
        footprintSnap: { pixelIndices: m.support, values: m.values },
      };
    case 'deprecate':
      return { kind: 'deprecate', t: frameIndex, id: m.id, reason: m.reason };
  }
}

function updateSchedulerFromEvent(scheduler: FootprintSnapshotScheduler, ev: PipelineEvent): void {
  // Mirror every structural event into the scheduler so the
  // log-spaced floor fires with the latest known footprint per
  // neuron (§9.3). Mutations without a footprint payload still
  // update the tracked neuron through their attached snap.
  switch (ev.kind) {
    case 'birth':
      scheduler.onBirth(ev.id, ev.t, ev.footprintSnap);
      return;
    case 'merge':
      scheduler.onMutationFootprint(ev.into, ev.t, ev.footprintSnap);
      return;
    case 'split':
      for (let i = 0; i < ev.into.length; i += 1) {
        const snap = ev.footprintSnaps[i];
        if (snap) scheduler.onMutationFootprint(ev.into[i], ev.t, snap);
      }
      return;
    case 'deprecate':
      scheduler.onDeprecate(ev.id);
      return;
    case 'reject':
    case 'metric':
    case 'footprint-snapshot':
      return;
  }
}

function drainMutationsOnce(h: RuntimeHandles, frameIndex: number): number {
  // Apply at most `mutationDrainMaxPerIteration` queued mutations so a
  // burst of extend proposals cannot stall the fit loop for more than
  // one frame's worth of apply cost (design §13 dense-scene risk).
  const cap = h.config.mutationDrainMaxPerIteration;
  let applied = 0;
  while (applied < cap) {
    const m = h.mutationQueue.pop();
    if (m === null) break;
    // Keep the WASM side in sync. In Phase 5 `drainApply` consumes
    // the Rust-side queue handle; once the SAB transport merges the
    // two queues this reduces to a single call.
    h.fitter.drainApply(h.mutationQueueHandle);
    const ev = mutationToEvent(m, frameIndex);
    if (ev) {
      h.eventBus.publish(ev);
      updateSchedulerFromEvent(h.footprintScheduler, ev);
    }
    post({ kind: 'mutation-applied', role: ROLE, epoch: h.fitter.epoch() });
    applied += 1;
  }
  return applied;
}

function emitScheduledFootprints(h: RuntimeHandles, frameIndex: number): void {
  const due = h.footprintScheduler.tick(frameIndex);
  for (const d of due) {
    h.eventBus.publish({
      kind: 'footprint-snapshot',
      t: d.t,
      neuronId: d.neuronId,
      footprint: d.footprint,
    });
  }
}

function takeCadencedSnapshot(h: RuntimeHandles, frameIndex: number): void {
  if (h.config.snapshotStride <= 0) return;
  if ((frameIndex + 1) % h.config.snapshotStride !== 0) return;
  // Request + publish in one shot: extend's in-worker stand-in hasn't
  // been wired yet, so fit serves a self-issued request. When the
  // real cross-worker transport lands, the request comes from extend
  // and this block calls only `publishAck`.
  const requestPromise = h.snapshotProtocol.requestSnapshot().catch(() => {
    // Capacity/timeout is a soft failure here — extend retries on
    // its own cadence per §7.2.
  });
  const request = h.snapshotProtocol.pollRequest();
  if (!request) {
    // Another snapshot is already in flight; skip to avoid piling up.
    return;
  }
  const handle = h.fitter.takeSnapshot();
  const ackEpoch = handle.epoch();
  const ackNumComponents = handle.numComponents();
  const ackPixels = handle.pixels();
  try {
    handle.free();
  } catch {
    // free() is best-effort — WASM may already be torn down
  }
  h.snapshotProtocol.publishAck({
    requestId: request.requestId,
    epoch: BigInt(ackEpoch),
    numComponents: ackNumComponents,
    pixels: ackPixels,
  });
  void requestPromise;
  post({ kind: 'snapshot-request', role: ROLE, requestId: request.requestId });
}

function residualL2(residual: ArrayLike<number> | Float32Array): number {
  let sumSq = 0;
  for (let i = 0; i < residual.length; i += 1) {
    const v = residual[i];
    sumSq += v * v;
  }
  return Math.sqrt(sumSq);
}

function emitVitals(h: RuntimeHandles, frameIndex: number): void {
  if (h.config.vitalsStride <= 0) return;
  if ((frameIndex + 1) % h.config.vitalsStride !== 0) return;

  const now = Date.now();
  const elapsedMs = now - h.lastVitalsTimeMs;
  const elapsedFrames = frameIndex - h.lastVitalsFrameIndex;
  const fps = h.lastVitalsTimeMs > 0 && elapsedMs > 0 ? (elapsedFrames * 1000) / elapsedMs : 0;
  h.lastVitalsTimeMs = now;
  h.lastVitalsFrameIndex = frameIndex;

  const metrics: { name: string; value: number }[] = [
    { name: METRIC_CELL_COUNT, value: h.fitter.numComponents() },
    { name: METRIC_FPS, value: fps },
    { name: METRIC_MEMORY_BYTES, value: calaMemoryBytes() ?? 0 },
    { name: METRIC_RESIDUAL_L2, value: h.lastResidualL2 },
    { name: METRIC_EXTEND_QUEUE_DEPTH, value: h.mutationQueue.len },
  ];
  for (const { name, value } of metrics) {
    h.eventBus.publish({ kind: 'metric', t: frameIndex, name, value });
  }
}

// Metric name for the per-cycle extend activity signal. Lives here
// (not in vitals.ts) because it is a *discovery* signal, not a
// header vital — the dashboard's event feed + metric timeseries
// surface it, the sparkline bar does not.
const METRIC_EXTEND_PROPOSED = 'extend.proposed';

function runExtendCycleIfDue(h: RuntimeHandles, frameIndex: number, residual: Float32Array): void {
  if (!h.extender || h.config.extendCycleStride <= 0) return;
  h.extender.pushResidual(residual);
  if ((frameIndex + 1) % h.config.extendCycleStride !== 0) return;
  const proposed = h.extender.runCycle(h.fitter, h.mutationQueueHandle);
  // Report activity to the archive even when zero: a long-running
  // flat line at 0 is itself a signal (quiet FOV or early residual
  // window).
  h.eventBus.publish({
    kind: 'metric',
    t: frameIndex,
    name: METRIC_EXTEND_PROPOSED,
    value: proposed,
  });
  // `runCycle` pushes to the Rust-side mutation queue. The JS-side
  // `drainMutationsOnce` only calls `drainApply` when its own queue
  // has items (from test injection), so the Rust queue would leak.
  // Apply any pending Rust mutations right here — epoch advances
  // and the cell_count vital reflects the extend's work.
  if (proposed > 0) {
    h.fitter.drainApply(h.mutationQueueHandle);
    post({ kind: 'mutation-applied', role: ROLE, epoch: h.fitter.epoch() });
  }
  // TODO Phase 7: surface the actual `register` payloads (support +
  // values + class + new id) as `birth` PipelineEvents. Requires a
  // new `Fitter.drainApplyEvents()` WASM binding that returns the
  // applied-mutation metadata alongside the apply counts. Until
  // then, births are visible through (a) epoch advance and (b)
  // cell_count vital, but not through the structural event feed.
}

async function fitLoop(h: RuntimeHandles): Promise<void> {
  let frameIndex = 0;
  while (!stopRequested) {
    const frame = readNextFrame(h);
    if (frame === null) {
      // No frame queued. Yield so the harness / decoder can push more
      // work without spinning the CPU. A microtask is enough — we're
      // inside a worker event loop, not a hard-spin context.
      await new Promise<void>((r) => setTimeout(r, h.config.frameChannelPollIntervalMs));
      continue;
    }
    const residual = h.fitter.step(frame);
    h.lastResidualL2 = residualL2(residual);
    runExtendCycleIfDue(h, frameIndex, residual);
    drainMutationsOnce(h, frameIndex);
    takeCadencedSnapshot(h, frameIndex);
    emitScheduledFootprints(h, frameIndex);
    emitVitals(h, frameIndex);
    if ((frameIndex + 1) % h.config.heartbeatStride === 0) {
      post({
        kind: 'frame-processed',
        role: ROLE,
        index: frameIndex,
        epoch: h.fitter.epoch(),
      });
    }
    frameIndex += 1;
    // Cooperative yield so stop() and new channel writes land
    // promptly in tests without racing the loop.
    await Promise.resolve();
  }
}

function cleanup(): void {
  if (!handles) return;
  try {
    handles.eventSubscription();
  } catch {
    // unsubscribe is best-effort
  }
  try {
    handles.eventBus.close();
  } catch {
    // close is idempotent but defensive
  }
  try {
    handles.fitter.free();
  } catch {
    // free is best-effort — wasm may already be torn down
  }
  try {
    handles.mutationQueueHandle.free();
  } catch {
    // free is best-effort
  }
  delete (globalThis as { __calaFitHandles?: unknown }).__calaFitHandles;
  handles = null;
}

function postDoneOnce(): void {
  if (donePosted) return;
  donePosted = true;
  post({ kind: 'done', role: ROLE });
}

async function handleRun(): Promise<void> {
  if (!handles) {
    postError(new Error("'run' received before successful 'init'"));
    return;
  }
  if (running) return;
  running = true;
  stopRequested = false;
  donePosted = false;
  const h = handles;
  try {
    await fitLoop(h);
    postDoneOnce();
  } catch (err) {
    postError(err);
  } finally {
    running = false;
    cleanup();
  }
}

async function handleStop(): Promise<void> {
  stopRequested = true;
  if (loopPromise) await loopPromise;
  postDoneOnce();
  cleanup();
}

function handleUserMutation(mutation: {
  kind: 'deprecate';
  id: number;
  reason: 'footprintCollapsed' | 'traceInactive' | 'mergedInto' | 'invalidApply';
}): void {
  if (!handles) return;
  // Main-thread authored mutation (§7.3). Push the Rust-side queue
  // via the existing binding, then drain-apply so the deprecate
  // lands on the next scheduler turn — mirrors the inline
  // drain-apply the extend cycle does.
  const reasonMap: Record<typeof mutation.reason, string> = {
    footprintCollapsed: 'FootprintCollapsed',
    traceInactive: 'TraceInactive',
    mergedInto: 'MergedInto',
    invalidApply: 'InvalidApply',
  };
  try {
    handles.mutationQueueHandle.pushDeprecate(
      BigInt(handles.fitter.epoch()),
      mutation.id,
      reasonMap[mutation.reason],
    );
    handles.fitter.drainApply(handles.mutationQueueHandle);
    post({ kind: 'mutation-applied', role: ROLE, epoch: handles.fitter.epoch() });
    // Surface as a structural event so the UI feed shows what the
    // user just did.
    handles.eventBus.publish({
      kind: 'deprecate',
      t: 0,
      id: mutation.id,
      reason: mutation.reason,
    });
  } catch (err) {
    postError(err);
  }
}

workerSelf.onmessage = (ev: MessageEvent<WorkerInbound>): void => {
  const msg = ev.data;
  switch (msg.kind) {
    case 'init':
      handleInit(msg.payload).catch(postError);
      return;
    case 'run':
      loopPromise = handleRun();
      return;
    case 'stop':
      handleStop().catch(postError);
      return;
    case 'snapshot-ack':
      // Ack of an upstream snapshot-request. In Phase 5 the
      // orchestrator forwards snapshot-ack back to fit for bookkeeping;
      // we log nothing — the in-worker SnapshotProtocol handled the
      // capture synchronously at the cadence boundary.
      return;
    case 'user-mutation':
      handleUserMutation(msg.mutation);
      return;
  }
};
