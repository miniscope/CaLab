/**
 * What the main thread knows about the compress worker: its latest status
 * (and the history of it), the back-fills and errors, for the status bar and
 * the measurement scripts. Back-filled traces go to the cell store's trace
 * history, and the last complete back-fill is kept as a result the export
 * can use when the run has no pass 2 (a live source has no file to re-read).
 */
import { createSignal } from 'solid-js';
import type { CompressStatus, CompressToMain } from '../workers/compress-types.ts';
import { MAX_MEMORY_TRACE_BYTES } from './trace-file.ts';

/** A finished back-fill. */
export interface BackfillInfo {
  version: number;
  frames: number;
  windows: number;
  msPerFrame: number;
  /** Wall time of the request and of the end, ms (the store's clock). */
  requestedMs: number;
  doneMs: number;
}

/** The traces of the last complete back-fill, frames x cells (solver order), from frame 0. */
export interface BackfillResult {
  ids: Uint32Array;
  traces: Float32Array;
  frames: number;
  cells: number;
  version: number;
  seconds: number;
}

/** One compress status as it arrived, with the time. */
export interface StatusPoint extends CompressStatus {
  t: number;
}

/** Where back-filled traces go (the cell store). */
export interface BackfillSink {
  onBackfill(
    first: boolean,
    start: number,
    count: number,
    ids: Uint32Array,
    traces: Float32Array,
  ): void;
}

/** Status points kept (one per window and per stream end: hours of recording). */
const MAX_STATUS_POINTS = 20_000;

export function createCompressStore(
  sink?: BackfillSink,
  clock: () => number = () => performance.now(),
) {
  const [status, setStatus] = createSignal<CompressStatus | null>(null);
  const [backfill, setBackfill] = createSignal<BackfillInfo | null>(null);
  const [result, setResult] = createSignal<BackfillResult | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  let session = -1;
  let requested = -1;
  /** The periodic back-fills: newest version asked for, whether one is running, how long the last took. */
  let periodicVersion = 0;
  let inFlight = false;
  let lastRequestMs = -Infinity;
  let lastDurationMs = 0;
  /** Requests not answered yet (the worker answers in order; a later one may supersede an earlier). */
  let requests: { version: number; requestedMs: number }[] = [];
  let history: StatusPoint[] = [];
  let backfills: BackfillInfo[] = [];
  /** The back-fill being received: its windows in arrival order. */
  let incoming: {
    version: number;
    ids: Uint32Array;
    parts: { start: number; count: number; traces: Float32Array }[];
    bytes: number;
  } | null = null;

  function finishIncoming(info: BackfillInfo): void {
    const inc = incoming;
    incoming = null;
    if (!inc || inc.version !== info.version || inc.parts.length === 0) return;
    const cells = inc.ids.length;
    let frames = 0;
    for (const p of inc.parts) {
      if (p.start !== frames) return; // not contiguous from frame 0: no result
      frames += p.count;
    }
    const traces = new Float32Array(frames * cells);
    for (const p of inc.parts) traces.set(p.traces, p.start * cells);
    setResult({
      ids: inc.ids,
      traces,
      frames,
      cells,
      version: inc.version,
      seconds: (info.doneMs - info.requestedMs) / 1000,
    });
  }

  return {
    status,
    backfill,
    /** The last complete back-fill's traces (null until one ran). */
    result,
    error,
    /** A new pipeline run: forget the previous one. */
    reset(next: number): void {
      session = next;
      requested = -1;
      periodicVersion = 0;
      inFlight = false;
      lastRequestMs = -Infinity;
      lastDurationMs = 0;
      requests = [];
      history = [];
      backfills = [];
      incoming = null;
      setStatus(null);
      setBackfill(null);
      setResult(null);
      setError(null);
    },
    /**
     * True once per run, when everything a back-fill needs is there: the
     * recording ended, the final library is out and has cells, and every
     * window is compressed.
     */
    takeBackfill(pipelineDone: boolean, libraryFinal: boolean, version: number): boolean {
      if (!pipelineDone || !libraryFinal || version <= 0 || !status()?.final) return false;
      if (requested === session) return false;
      requested = session;
      inFlight = true;
      lastRequestMs = clock();
      requests.push({ version, requestedMs: lastRequestMs });
      periodicVersion = Math.max(periodicVersion, version);
      return true;
    },
    /**
     * True when a back-fill during the run is due: a library newer than the
     * last one back-filled is out, at least one window is compressed and none
     * is waiting, no back-fill is running, and at least `everyMs` (and twice
     * the last back-fill's duration, so it never takes most of the worker)
     * has passed since the last request.
     */
    takePeriodic(version: number, everyMs: number): boolean {
      const s = status();
      if (version <= periodicVersion || !s || s.windows === 0 || s.pending > 0 || s.final)
        return false;
      if (inFlight || requested === session) return false;
      if (clock() - lastRequestMs < Math.max(everyMs, 2 * lastDurationMs)) return false;
      periodicVersion = version;
      inFlight = true;
      lastRequestMs = clock();
      requests.push({ version, requestedMs: lastRequestMs });
      return true;
    },
    /** Every status the worker sent this run, with the time it arrived. */
    history: () => history,
    /** Every back-fill that finished this run. */
    backfills: () => backfills,
    onMessage(msg: CompressToMain): void {
      if (msg.type === 'error') setError(msg.message);
      else if (msg.session !== session) return;
      else if (msg.type === 'status') {
        setStatus(msg.status);
        if (history.length < MAX_STATUS_POINTS) history.push({ ...msg.status, t: clock() });
      } else if (msg.type === 'traces') {
        sink?.onBackfill(msg.first, msg.start, msg.count, msg.ids, msg.traces);
        if (msg.first) incoming = { version: msg.version, ids: msg.ids, parts: [], bytes: 0 };
        const inc = incoming;
        if (inc && inc.version === msg.version) {
          inc.bytes += msg.traces.byteLength;
          if (inc.bytes <= MAX_MEMORY_TRACE_BYTES)
            inc.parts.push({ start: msg.start, count: msg.count, traces: msg.traces });
          else incoming = null;
        }
      } else {
        const now = clock();
        // The requests this answers: the earliest, and any later one it superseded.
        const answered = requests.filter((r) => r.version <= msg.version);
        requests = requests.filter((r) => r.version > msg.version);
        const requestedMs = answered[0]?.requestedMs ?? now;
        const info: BackfillInfo = {
          version: msg.version,
          frames: msg.frames,
          windows: msg.windows,
          msPerFrame: msg.msPerFrame,
          requestedMs,
          doneMs: now,
        };
        inFlight = requests.length > 0;
        lastDurationMs = now - requestedMs;
        backfills.push(info);
        setBackfill(info);
        finishIncoming(info);
      }
    },
  };
}

export type CompressStore = ReturnType<typeof createCompressStore>;

/** `4 windows · rank 5.6 · 8.6 ms/frame · 41 MB · traces back-filled (2,000 frames, 2.1 ms/frame)`. */
export function compressReadout(s: CompressStatus | null, b: BackfillInfo | null = null): string {
  if (!s || s.windows === 0) return 'Compression: waiting for the first window';
  const mb = (s.factorBytes / 1048576).toFixed(0);
  const waiting = s.pending > 0 ? ` · ${s.pending} waiting` : '';
  const filled = b
    ? ` · traces back-filled (${b.frames.toLocaleString('en-US')} frames, ${b.msPerFrame.toFixed(1)} ms/frame)`
    : '';
  return (
    `Compression: ${s.windows} windows · rank ${s.meanRank.toFixed(1)} · ` +
    `${s.msPerFrame.toFixed(1)} ms/frame · ${mb} MB${waiting}${filled}`
  );
}
