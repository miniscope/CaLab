/**
 * What the main thread knows about the compress worker: its latest status
 * and error, for the status bar.
 */
import { createSignal } from 'solid-js';
import type { CompressStatus, CompressToMain } from '../workers/compress-types.ts';

export function createCompressStore() {
  const [status, setStatus] = createSignal<CompressStatus | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  let session = -1;
  return {
    status,
    error,
    /** A new pipeline run: forget the previous one. */
    reset(next: number): void {
      session = next;
      setStatus(null);
      setError(null);
    },
    onMessage(msg: CompressToMain): void {
      if (msg.type === 'error') setError(msg.message);
      else if (msg.session === session) setStatus(msg.status);
    },
  };
}

export type CompressStore = ReturnType<typeof createCompressStore>;

/** `12 windows · rank 17.5 · 6.1 ms/frame · 310 MB · 1 waiting`. */
export function compressReadout(s: CompressStatus | null): string {
  if (!s || s.windows === 0) return 'Compression: waiting for the first window';
  const mb = (s.factorBytes / 1048576).toFixed(0);
  const waiting = s.pending > 0 ? ` · ${s.pending} waiting` : '';
  return (
    `Compression: ${s.windows} windows · rank ${s.meanRank.toFixed(1)} · ` +
    `${s.msPerFrame.toFixed(1)} ms/frame · ${mb} MB${waiting}`
  );
}
