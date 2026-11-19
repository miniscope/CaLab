/**
 * What the main thread knows about the compress worker: its latest status,
 * the back-fill and errors, for the status bar. Back-filled traces go to the
 * cell store's trace history.
 */
import { createSignal, untrack } from 'solid-js';
import type { CompressStatus, CompressToMain } from '../workers/compress-types.ts';
import type { FovProjections } from './fov-projection.ts';

/** A finished back-fill. */
export interface BackfillInfo {
  version: number;
  frames: number;
  msPerFrame: number;
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

/**
 * Where the recalibrated factors of a run stand: `ready` once a replay's
 * windows on the offset grids hold every frame and none waits; `unusable`
 * after a compression error or when a finished replay's windows do not hold
 * every frame (a skipped last window of one frame); `compressing` while a
 * replay that compresses runs or its windows wait; `none` otherwise (the next
 * replay may compress).
 */
export type FactorState = 'none' | 'compressing' | 'ready' | 'unusable';

export function factorState(
  s: CompressStatus | null,
  error: string | null,
  replayCompressing: boolean,
  frames: number,
): FactorState {
  if (error) return 'unusable';
  const replay = s !== null && s.source === 'replay';
  if (replay && s.final && s.pending === 0)
    return s.tiling === 'offset' && frames > 0 && s.frames === frames ? 'ready' : 'unusable';
  // A cancelled replay leaves a status without windows: that is not compressing.
  if (replayCompressing || (replay && (s.windows > 0 || s.pending > 0))) return 'compressing';
  return 'none';
}

/**
 * The messages of an Extract job. `abort` is the store's own: the job can no
 * longer be answered, so it fails. `reset`: a new run reset the store (not a
 * failure of the factors); false: a compression error.
 */
export type ExtractMessage =
  | Extract<CompressToMain, { type: 'extracted' | 'extract-done' }>
  | (Extract<CompressToMain, { type: 'error' }> & { job: number })
  | { type: 'abort'; message: string; reset: boolean };

/**
 * What Extract will read now (the Run panel, compression on).
 * `compressionFailed`: the compress store has an error (the factors are then
 * `unusable` whatever they hold).
 */
export function extractSourceText(
  state: FactorState,
  s: CompressStatus | null,
  factorsFailed = false,
  compressionFailed = false,
): string {
  switch (state) {
    case 'ready':
      // After a failed factor Extract the next one replays the file.
      if (factorsFailed) return 'Extract replays the file: the last Extract on the factors failed.';
      return 'Extract reads the factors (seconds).';
    case 'compressing':
      return `Extract replays the file: the factors are being compressed${
        s && s.pending > 0 ? ` (${s.pending} windows waiting)` : ''
      }.`;
    case 'unusable':
      // A storage error (no OPFS in a private window, a quota) is not a coverage gap.
      if (compressionFailed) return 'Extract replays the file: the compression failed.';
      return 'Extract replays the file: the factors do not cover the recording.';
    default:
      return 'Extract replays the file; the first replay compresses the frames for later Extracts.';
  }
}

/**
 * Compression is on unless the URL has `compress=off` (then Refine and
 * Extract replay the file as before phase 4). `?compress` alone, the old
 * opt-in, still means on.
 */
export function compressionOn(params: URLSearchParams): boolean {
  return params.get('compress') !== 'off';
}

/** `isLive`: whether the run is a live stream (its back-fill is never asked for nor applied). */
export function createCompressStore(sink?: BackfillSink, isLive: () => boolean = () => false) {
  const [status, setStatus] = createSignal<CompressStatus | null>(null);
  const [backfill, setBackfill] = createSignal<BackfillInfo | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  let session = -1;
  let requested = -1;
  /** The token of the replay that compresses and was not cut short (0: none); a signal, so the panel follows it. */
  const [mark, setMark] = createSignal(0);
  let lastMark = 0;
  /** Projections of the replay that made the factors (a factor Extract's FOV images). */
  let projection: FovProjections | null = null;
  const listeners = new Set<(m: ExtractMessage) => void>();
  /** Fail every pending Extract job and forget it, so its later messages find no listener. */
  const abortJobs = (message: string, reset: boolean): void => {
    const pending = [...listeners];
    listeners.clear();
    for (const l of pending) l({ type: 'abort', message, reset });
  };
  return {
    status,
    backfill,
    error,
    /** A new pipeline run: forget the previous one. */
    reset(next: number): void {
      abortJobs('The run was reset.', true);
      session = next;
      requested = -1;
      setMark(0);
      projection = null;
      setStatus(null);
      setBackfill(null);
      setError(null);
    },
    /**
     * True once per run, when everything a back-fill needs is there: the
     * recording ended, the final library is out and has cells, and every
     * window of Discover's live factors is compressed. The windows of
     * Extract's replay (source `replay`) are never back-filled.
     */
    takeBackfill(pipelineDone: boolean, libraryFinal: boolean, version: number): boolean {
      const s = status();
      if (!pipelineDone || !libraryFinal || version <= 0 || !s?.final) return false;
      if (s.source !== 'discover') return false;
      // A live run keeps the fast loop's traces: the factors of a stream are not validated for this yet.
      if (isLive()) return false;
      if (requested === session) return false;
      requested = session;
      return true;
    },
    onMessage(msg: CompressToMain): void {
      if (msg.type === 'error') {
        // An Extract job's error is the job's: the factors stay usable.
        if (msg.job !== undefined) {
          if (msg.session === session) for (const l of [...listeners]) l(msg as ExtractMessage);
          return;
        }
        // An error of an earlier run (or none: -1, a crashed worker) is not this run's.
        if (msg.session !== session && msg.session !== -1) return;
        setError(msg.message);
        abortJobs(msg.message, false);
        return;
      }
      if (msg.session !== session) return;
      if (msg.type === 'status') setStatus(msg.status);
      else if (msg.type === 'traces') {
        // Second line: a late back-fill must not clear a live run's history.
        if (isLive()) return;
        sink?.onBackfill(msg.first, msg.start, msg.count, msg.ids, msg.traces);
      } else if (msg.type === 'backfilled') {
        setBackfill({ version: msg.version, frames: msg.frames, msPerFrame: msg.msPerFrame });
      } else for (const l of [...listeners]) l(msg);
    },
    /** The session of this run: jobs go out under it and only its replies count. */
    session: (): number => session,
    /** Where the factors of this run stand, for a recording of `frames` frames. */
    factors: (frames: number): FactorState => factorState(status(), error(), mark() !== 0, frames),
    /**
     * A replay that compresses starts. Returns its release: `ended(false)`
     * (cut short, its windows are dropped) frees the mark, `ended(true)` keeps
     * it until the factors are ready. Only the replay that took the mark can
     * free it; a call after a reset or a second call does nothing.
     */
    markReplay(): (ok: boolean) => void {
      const token = ++lastMark;
      setMark(token);
      return (ok) => {
        if (!ok && untrack(mark) === token) setMark(0);
      };
    },
    keepProjection(p: FovProjections): void {
      projection = p;
    },
    projection: (): FovProjections | null => projection,
    /**
     * Listen to the messages of one Extract job; returns the unsubscribe. Every
     * listener is dropped at a reset and at a compression error (after an
     * `abort` message), so this is not a lasting subscription.
     */
    onExtract(listener: (m: ExtractMessage) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type CompressStore = ReturnType<typeof createCompressStore>;

/**
 * `Compression: 4 windows · rank 5.6 · 8.6 ms/frame · 41 MB · traces back-filled (2,000 frames, 2.1 ms/frame)`,
 * or `Recalibrated factors: ...` for the windows of Extract's replay.
 */
export function compressReadout(s: CompressStatus | null, b: BackfillInfo | null = null): string {
  if (!s || s.windows === 0) return 'Compression: waiting for the first window';
  const replay = s.source === 'replay';
  const mb = (s.factorBytes / 1048576).toFixed(0);
  const waiting = s.pending > 0 ? ` · ${s.pending} waiting` : '';
  const filled =
    b && !replay
      ? ` · traces back-filled (${b.frames.toLocaleString('en-US')} frames, ${b.msPerFrame.toFixed(1)} ms/frame)`
      : '';
  return (
    `${replay ? 'Recalibrated factors' : 'Compression'}: ${s.windows} windows · ` +
    `rank ${s.meanRank.toFixed(1)} · ${s.msPerFrame.toFixed(1)} ms/frame · ${mb} MB${waiting}${filled}`
  );
}
