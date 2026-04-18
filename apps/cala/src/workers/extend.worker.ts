/**
 * W3 — extend worker (STUB for Phase 5, Task 23).
 *
 * The real extend loop (snapshot request → segmentation → mutation
 * publish against the `(Ã, W, M)` view it snapshotted) lands in a
 * follow-on phase. Here we ship just enough to exercise the
 * orchestrator's 4-worker lifecycle (design §7) in the Phase 5 exit
 * E2E: a heartbeat tick that observes snapshot-ack epoch advances and
 * surfaces one metric event + one `frame-processed` message per
 * stride.
 *
 * Explicitly NOT in this stub: reading preprocessed frames, any trace
 * maths, any `cala-core` WASM call, any mutation publish. Keeping the
 * surface minimal here prevents half-baked fit-adjacent code from
 * calcifying.
 */

import type {
  WorkerInbound,
  WorkerInitPayload,
  WorkerOutbound,
  PipelineEvent,
} from '@calab/cala-runtime';

// Heartbeat cadence in ms. Rationale: extend's real cycle is "next
// frame boundary after snapshot", not a wall-clock tick; but until
// that logic lands we need a deterministic lifecycle pulse for the
// orchestrator's readiness/done handshake. Overridable via
// `workerConfig.heartbeatStrideMs` (no-magic-numbers rule).
const DEFAULT_HEARTBEAT_STRIDE_MS = 500;
// Inner tick granularity: how often the loop wakes to re-check stop
// and accumulate time toward the next heartbeat. Short enough that
// `stop` feels prompt, long enough not to burn CPU in the stub.
const DEFAULT_TICK_INTERVAL_MS = 10;

const ROLE = 'extend' as const;

interface WorkerGlobalScope {
  postMessage(msg: WorkerOutbound): void;
  onmessage: ((ev: MessageEvent<WorkerInbound>) => void) | null;
}

interface ExtendWorkerConfig {
  heartbeatStrideMs: number;
  tickIntervalMs: number;
}

const workerSelf = ((globalThis as unknown as { self?: WorkerGlobalScope }).self ??
  (globalThis as unknown as WorkerGlobalScope)) as WorkerGlobalScope;

interface RuntimeHandles {
  cfg: ExtendWorkerConfig;
  tickCount: number;
  lastObservedEpoch: bigint;
  // Epoch last published from a snapshot ack that we have not yet
  // reflected in a heartbeat. Treated as a single-slot latch so
  // heartbeats always surface the most recent ack.
  pendingAckEpoch: bigint | null;
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

function parseConfig(raw: unknown): ExtendWorkerConfig {
  const cfg = asRecord(raw);
  return {
    heartbeatStrideMs:
      typeof cfg.heartbeatStrideMs === 'number' && cfg.heartbeatStrideMs > 0
        ? cfg.heartbeatStrideMs
        : DEFAULT_HEARTBEAT_STRIDE_MS,
    tickIntervalMs:
      typeof cfg.tickIntervalMs === 'number' && cfg.tickIntervalMs > 0
        ? cfg.tickIntervalMs
        : DEFAULT_TICK_INTERVAL_MS,
  };
}

function handleInit(payload: WorkerInitPayload): void {
  const cfg = parseConfig(payload.workerConfig);
  handles = {
    cfg,
    tickCount: 0,
    lastObservedEpoch: 0n,
    pendingAckEpoch: null,
  };
  post({ kind: 'ready', role: ROLE });
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, ms));
}

async function heartbeatLoop(h: RuntimeHandles): Promise<void> {
  let sinceLastBeatMs = 0;
  while (!stopRequested) {
    await sleep(h.cfg.tickIntervalMs);
    if (stopRequested) return;
    sinceLastBeatMs += h.cfg.tickIntervalMs;
    if (sinceLastBeatMs < h.cfg.heartbeatStrideMs) continue;
    sinceLastBeatMs = 0;
    h.tickCount += 1;

    // Latch consumption: if a snapshot ack arrived since the previous
    // heartbeat, advance epoch and publish the corresponding metric
    // event. Otherwise just emit the frame-processed beat.
    const newlyObserved = h.pendingAckEpoch;
    if (newlyObserved !== null && newlyObserved > h.lastObservedEpoch) {
      h.lastObservedEpoch = newlyObserved;
      h.pendingAckEpoch = null;
      const metric: PipelineEvent = {
        kind: 'metric',
        t: h.tickCount,
        name: 'extend.heartbeat',
        value: h.tickCount,
      };
      post({ kind: 'event', role: ROLE, event: metric });
    }

    post({
      kind: 'frame-processed',
      role: ROLE,
      index: h.tickCount,
      epoch: h.lastObservedEpoch,
    });
  }
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
    await heartbeatLoop(h);
    postDoneOnce();
  } catch (err) {
    postError(err);
  } finally {
    running = false;
  }
}

async function handleStop(): Promise<void> {
  stopRequested = true;
  if (loopPromise) await loopPromise;
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
      loopPromise = handleRun();
      return;
    case 'stop':
      handleStop().catch(postError);
      return;
    case 'snapshot-ack':
      if (handles) {
        // Latch — real extend would gate segmentation on this; stub
        // just stamps the epoch onto subsequent heartbeats.
        handles.pendingAckEpoch = msg.epoch;
      }
      return;
    case 'event':
    case 'request-archive-dump':
      // Extend never consumes these — archive-targeted messages.
      return;
  }
};
