/**
 * What the main thread knows about the compress worker: its latest status,
 * the back-fill and errors, for the status bar. Back-filled traces go to the
 * cell store's trace history.
 */
import { createSignal } from 'solid-js';
import type { CompressStatus, CompressToMain } from '../workers/compress-types.ts';

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

export function createCompressStore(sink?: BackfillSink) {
  const [status, setStatus] = createSignal<CompressStatus | null>(null);
  const [backfill, setBackfill] = createSignal<BackfillInfo | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  let session = -1;
  let requested = -1;
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
      if (msg.type === 'error') setError(msg.message);
      else if (msg.session !== session) return;
      else if (msg.type === 'status') setStatus(msg.status);
      else if (msg.type === 'traces') {
        sink?.onBackfill(msg.first, msg.start, msg.count, msg.ids, msg.traces);
      } else setBackfill({ version: msg.version, frames: msg.frames, msPerFrame: msg.msPerFrame });
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
