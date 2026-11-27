// Memory figures for the run telemetry (docs/analytics.md, `peak_wasm_mb`).
//
// The solver, visit, flat-field, trace and compress WASM instances live in
// workers, so the main thread cannot read their heaps. Every thread that loads
// the WASM module reports the size of its linear memory over a same-origin
// BroadcastChannel every few seconds (no per-frame or per-batch message, no
// wiring through the pipeline channels); the main thread keeps the last report
// of each thread and sums them with its own.
//
// No JS-heap figure is reported: `performance.memory` (Chrome only) sees the
// main thread alone, a small share of the tab's footprint, and workers have
// none.

const CHANNEL = 'calab-cala-memory';
/** A thread silent for this long has exited (or is stuck in one long call): drop it. */
export const REPORT_TTL_MS = 30_000;
export const REPORT_EVERY_MS = 2_000;

interface Report {
  wasm: number;
  at: number;
}
const reports = new Map<string, Report>();
let ownHeap: () => number = () => 0;

/** Record a worker's WASM heap size (bytes). Exported for tests. */
export function recordThreadHeap(id: string, wasmBytes: number, now = Date.now()): void {
  if (Number.isFinite(wasmBytes) && wasmBytes >= 0) reports.set(id, { wasm: wasmBytes, at: now });
}

/** Sum of this thread's WASM heap and the latest report of every live worker. */
export function totalWasmHeapBytes(now = Date.now()): number {
  let sum = ownHeap();
  for (const [id, r] of reports) {
    if (now - r.at > REPORT_TTL_MS) reports.delete(id);
    else sum += r.wasm;
  }
  return sum;
}

/** Main thread: listen for the workers' reports; `own` is this thread's WASM heap. */
export function startMemoryCollector(own: () => number): () => void {
  ownHeap = own;
  if (typeof BroadcastChannel === 'undefined') return () => {};
  const ch = new BroadcastChannel(CHANNEL);
  ch.onmessage = (e: MessageEvent) => {
    const d = e.data as { id?: unknown; wasm?: unknown } | null;
    if (typeof d?.id === 'string' && typeof d.wasm === 'number') recordThreadHeap(d.id, d.wasm);
  };
  return () => {
    ch.close();
    ownHeap = () => 0;
    reports.clear();
  };
}

/** Worker: report this thread's WASM heap size every `everyMs` (returns the stop function). */
export function startMemoryReporter(
  heap: () => number,
  everyMs = REPORT_EVERY_MS,
  id: string = Math.random().toString(36).slice(2),
): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => {};
  const ch = new BroadcastChannel(CHANNEL);
  const post = () => {
    try {
      ch.postMessage({ id, wasm: heap() });
    } catch {
      // Telemetry never throws.
    }
  };
  const timer = setInterval(post, everyMs);
  (timer as { unref?: () => void }).unref?.();
  post();
  return () => {
    clearInterval(timer);
    ch.close();
  };
}
