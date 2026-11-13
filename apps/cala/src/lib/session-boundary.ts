/**
 * Session boundaries inside a multi-session recording (a Joint run, see
 * `docs/stages.md`): the frame where a new session starts.
 *
 * This is plumbing only. The pipeline engines call `onSessionBoundary` when
 * the batch they are about to process holds the first frame of a session,
 * before any of that batch is preprocessed. The default does nothing, so a
 * run goes straight across the boundary as it did when sessions were
 * concatenated by hand. Boundary handling (re-registration, state resets,
 * per-session gain) will plug in here once it has been measured.
 */

export interface SessionHooks {
  /**
   * Session `index` (1-based within the run: 1 is the second session) starts
   * at global frame `frame`, inside the batch about to be processed.
   */
  onSessionBoundary(index: number, frame: number): void;
}

/** The hook that does nothing: today's behaviour. */
export const NO_SESSION_HOOKS: SessionHooks = {
  onSessionBoundary() {},
};

/**
 * Boundaries in the batch of frames `[start, start + count)`: the session
 * index and frame of every boundary in it. `boundaries[k]` is the first
 * frame of session `k + 1`.
 */
export function boundariesInBatch(
  boundaries: readonly number[],
  start: number,
  count: number,
): { index: number; frame: number }[] {
  const out: { index: number; frame: number }[] = [];
  boundaries.forEach((frame, k) => {
    if (frame >= start && frame < start + count) out.push({ index: k + 1, frame });
  });
  return out;
}
