/**
 * What the main thread knows about the history review (the review worker's
 * status and errors, for the status bar), and the hand-over of what a review
 * found to the slow loop.
 */
import { createSignal } from 'solid-js';
import type { ReviewStatus, ReviewToMain } from '../workers/review-types.ts';

/** Compressed windows between two reviews (as `discover_eval --history-review 8`). */
export const REVIEW_EVERY_WINDOWS = 8;

/**
 * The `?review` URL switch: `null` when absent (no review), else the windows
 * between two reviews: `?review=N`, or the default for `?review`.
 */
export function reviewEvery(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return value !== '' && Number.isInteger(n) && n >= 1 ? n : REVIEW_EVERY_WINDOWS;
}

/**
 * `every`: windows between two reviews. `apply`: pass a review's candidates
 * to the slow loop of `session`.
 */
export function createReviewStore(
  every: number,
  apply: (session: number, candidates: Float32Array) => void,
) {
  const [status, setStatus] = createSignal<ReviewStatus | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  let session = -1;
  return {
    every,
    status,
    error,
    /** A new pipeline run: forget the previous one. */
    reset(next: number): void {
      session = next;
      setStatus(null);
      setError(null);
    },
    onMessage(msg: ReviewToMain): void {
      if (msg.type === 'error') setError(`History review: ${msg.message}`);
      else if (msg.session !== session) return;
      else if (msg.type === 'status') setStatus(msg.status);
      else apply(msg.session, msg.candidates);
    },
  };
}

export type ReviewStore = ReturnType<typeof createReviewStore>;

const plural = (n: number, word: string): string =>
  `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

/**
 * `History review: 3 reviews · 14 candidates · 6 cells added · last 38.2 s`.
 * `added`: the slow loop's count of cells it took from reviews.
 */
export function reviewReadout(s: ReviewStatus | null, added: number, every: number): string {
  if (!s || (s.reviews === 0 && !s.running)) {
    return `History review: every ${plural(every, 'window')}, none yet`;
  }
  const running = s.running ? ' · reviewing' : '';
  if (s.reviews === 0) return `History review: first review${running}`;
  const skipped = s.skipped > 0 ? ` · ${s.skipped} skipped` : '';
  return (
    `History review: ${plural(s.reviews, 'review')} · ${plural(s.candidates, 'candidate')} · ` +
    `${plural(added, 'cell')} added · last ${s.seconds.toFixed(1)} s${skipped}${running}`
  );
}
