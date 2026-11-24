/**
 * What the main thread knows about the compress worker: its latest status,
 * the back-fill and errors, for the status bar. Back-filled traces go to the
 * cell store's trace history.
 */
import { createSignal } from 'solid-js';
import type {
  CompressedWindow,
  CompressStatus,
  CompressTiling,
  CompressToMain,
} from '../workers/compress-types.ts';
import { FACTOR_TAIL_FILE, FACTOR_TILING } from './factor-run.ts';

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

/** A live run's factors (`?factors`; spec decision 4). */
export type FactorState = 'none' | 'compressing' | 'ready' | 'unusable';

/** What Extract and the settle read: the run folder and its windows. */
export interface FactorInfo {
  folder: string;
  tiling: CompressTiling;
  windows: CompressedWindow[];
  /** Frames the windows cover from frame 0. */
  frames: number;
  meanRank: number;
}

/** The frames the windows cover from frame 0, and the first frame missing between two (null: none). */
export function factorCoverage(windows: readonly CompressedWindow[]): {
  frames: number;
  gap: number | null;
} {
  let end = 0;
  for (const w of [...windows].sort((a, b) => a.start - b.start)) {
    if (w.start !== end) return { frames: end, gap: end };
    end += w.frames;
  }
  return { frames: end, gap: null };
}

/**
 * The factors of a live run with `?factors`, whose `frames` frames Discover
 * read: `ready` once the stream ended, no window waits, they are on the
 * offset grids and cover frames 0.. without a gap, all but at most the last
 * (a window of one frame cannot be compressed); `unusable` after a
 * compression error or when they do not; `compressing` before.
 */
export function factorState(
  s: CompressStatus | null,
  error: string | null,
  ended: boolean,
  frames: number,
  tail = true,
): FactorState {
  if (error) return 'unusable';
  if (!ended || !s || !s.final || s.pending > 0) return 'compressing';
  if (s.tiling !== FACTOR_TILING) return 'unusable';
  const c = factorCoverage(s.compressed);
  const covers = tail ? c.frames <= frames && c.frames >= frames - 1 : c.frames === frames;
  return c.gap === null && c.frames >= 2 && covers ? 'ready' : 'unusable';
}

export function factorsBlocked(
  state: FactorState,
  s: CompressStatus | null,
  error: string | null,
): string | null {
  switch (state) {
    case 'ready':
      return null;
    case 'compressing':
      return `Waiting for the last windows to be compressed${s && s.pending > 0 ? ` (${s.pending} waiting)` : ''}.`;
    case 'unusable':
      return error
        ? `The factors cannot be read: ${error}`
        : 'The factors do not cover the stream.';
    default:
      return 'This run has no factors.';
  }
}

/** Why a recording's settle or Extract re-reads the file (null: the factors can be read). */
export function fileFactorsBlocked(
  state: FactorState,
  s: CompressStatus | null,
  error: string | null,
  frames: number,
): string | null {
  switch (state) {
    case 'ready':
      return null;
    case 'compressing': {
      const left = Math.max(0, frames - (s?.frames ?? 0));
      return `${left.toLocaleString('en-US')} frames are still being compressed.`;
    }
    case 'unusable':
      if (error) return `The factors cannot be read: ${error}`;
      return s && factorCoverage(s.compressed).frames === frames - 1
        ? FACTOR_TAIL_FILE
        : 'The factors do not cover the recording.';
    default:
      return 'This run has no factors.';
  }
}

/** The factors' wait gives up after this long without a change in the compressor. */
export const FACTOR_STALL_MS = 120_000;

/** Notices a compressor that stopped (a lost OPFS open never settles; see `pinned`). */
export class FactorWatchdog {
  private key = '';
  private since = 0;
  constructor(private readonly stallMs = FACTOR_STALL_MS) {}
  note(s: CompressStatus | null, now: number): void {
    const key = s ? `${s.windows}/${s.pending}/${s.final}` : '-';
    if (key !== this.key || this.since === 0) {
      this.key = key;
      this.since = now;
    }
  }
  stalled(now: number): boolean {
    return this.since !== 0 && now - this.since >= this.stallMs;
  }
  reset(): void {
    this.key = '';
    this.since = 0;
  }
}

/** What Extract's port hears: the compress worker's Extract and error messages, and a reset (a new run). */
export type ExtractMessage = CompressToMain | { type: 'reset' };

export function createCompressStore(sink?: BackfillSink) {
  const [status, setStatus] = createSignal<CompressStatus | null>(null);
  const [backfill, setBackfill] = createSignal<BackfillInfo | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  let session = -1;
  let requested = -1;
  let onExtract: ((msg: ExtractMessage) => void) | undefined;
  // Everything that waits for the next status, error or reset (`changed`).
  const waiters: (() => void)[] = [];
  const wake = (): void => {
    for (const w of waiters.splice(0)) w();
  };
  return {
    status,
    backfill,
    error,
    /** A new pipeline run: forget the previous one. */
    reset(next: number): void {
      session = next;
      requested = -1;
      setStatus(null);
      setBackfill(null);
      setError(null);
      wake();
      onExtract?.({ type: 'reset' });
    },
    /** Resolves at the next status, error or reset. */
    changed: (): Promise<void> => new Promise<void>((r) => waiters.push(r)),
    /** Mark the factors unusable (the compressor stalled), with the reason. */
    fail(message: string): void {
      setError(message);
      wake();
    },
    /** The state of a live run's factors (`ended`: the stream is over; `frames`: what Discover read). */
    factors(ended: boolean, frames: number): FactorState {
      return factorState(status(), error(), ended, frames);
    },
    /** The state of a recording's factors (every frame covered; `frames`: what Discover read). */
    fileFactors(ended: boolean, frames: number): FactorState {
      return factorState(status(), error(), ended, frames, false);
    },
    /** Frames Discover read that are not compressed yet. */
    behind(frames: number): number {
      return Math.max(0, frames - (status()?.frames ?? 0));
    },
    /** The run folder and windows Extract and the settle read (null before the first status). */
    factorInfo(): FactorInfo | null {
      const s = status();
      if (!s) return null;
      return {
        folder: s.folder,
        tiling: s.tiling,
        windows: s.compressed,
        frames: factorCoverage(s.compressed).frames,
        meanRank: s.meanRank,
      };
    },
    /** Extract's messages: its windows, its end, its errors, a crash and a reset. */
    get onExtract() {
      return onExtract;
    },
    set onExtract(fn: ((msg: ExtractMessage) => void) | undefined) {
      onExtract = fn;
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
      return true;
    },
    onMessage(msg: CompressToMain): void {
      if (msg.type === 'error') {
        // An error of an Extract job ends that job only; every other one marks the factors unusable.
        if (msg.job === undefined) {
          setError(msg.message);
          wake();
        }
        // A crash (session -1), an error of this run and a job's error end an Extract job.
        if (msg.job !== undefined || msg.session === -1 || msg.session === session)
          onExtract?.(msg);
      } else if (msg.session !== session) return;
      else if (msg.type === 'extracted' || msg.type === 'extract-done') onExtract?.(msg);
      else if (msg.type === 'status') {
        setStatus(msg.status);
        wake();
      } else if (msg.type === 'traces') {
        sink?.onBackfill(msg.first, msg.start, msg.count, msg.ids, msg.traces);
      } else setBackfill({ version: msg.version, frames: msg.frames, msPerFrame: msg.msPerFrame });
    },
  };
}

export type CompressStore = ReturnType<typeof createCompressStore>;

/**
 * `4 windows · rank 5.6 · 8.6 ms/frame · 41 MB · traces back-filled (2,000 frames, 2.1 ms/frame)`;
 * with a pool `12 windows · 3 workers · 118 fps · rank 5.6 · … · 9 waiting (3.9 GB on disk)`.
 */
export function compressReadout(s: CompressStatus | null, b: BackfillInfo | null = null): string {
  if (!s || s.windows === 0) return 'Compression: waiting for the first window';
  const mb = (s.factorBytes / 1048576).toFixed(0);
  const pool =
    (s.workers ?? 1) > 1 ? `${s.workers} workers · ${Math.round(s.fps ?? 0)} fps · ` : '';
  const disk =
    s.backlogBytes !== undefined && s.backlogBytes > 0
      ? ` (${(s.backlogBytes / 2 ** 30).toFixed(1)} GB on disk)`
      : '';
  const waiting = s.pending > 0 ? ` · ${s.pending} waiting${disk}` : '';
  const filled = b
    ? ` · traces back-filled (${b.frames.toLocaleString('en-US')} frames, ${b.msPerFrame.toFixed(1)} ms/frame)`
    : '';
  return (
    `Compression: ${s.windows} windows · ${pool}rank ${s.meanRank.toFixed(1)} · ` +
    `${s.msPerFrame.toFixed(1)} ms/frame · ${mb} MB${waiting}${filled}`
  );
}
