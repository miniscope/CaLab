/**
 * Session boundaries inside a multi-session recording (a Joint run, see
 * `docs/stages.md`): the frame where a new session starts.
 *
 * The pipeline engines call `onSessionBoundary` when the batch they are
 * about to process starts a session (the plan cuts batches at boundaries),
 * before any of it is preprocessed. The hook itself is for observers; the
 * boundary handling runs in the stages when `PipelineOptions.sessionFix` is
 * on (the default), measured in
 * `tools/cala-eval/results/2026-11-13-session-boundary-fix.md`:
 *
 * - stage A re-seats the flicker reference on the new session
 *   (`Preprocessor.beginSessionFront`);
 * - stage B registers the new session's first batch onto the mean of the
 *   previous session's last `SESSION_REFERENCE_FRAMES` registered frames
 *   (rotation and a wide translation, `SessionAligner.beginSession`) and
 *   warps every frame of the session by it before the per-frame corrector;
 * - stage C maps the background floor into the new session's brightness and
 *   rescales the noise map (`Preprocessor.beginSessionBack`), and validates
 *   pixels against the FOV mask as the session warp moved it.
 *
 * Replays (Refine, Extract) re-run A's and C's steps from the replayed
 * frames and apply B's recorded transform (`RunRecord.noteSession`).
 */

/** Registered frames before a boundary averaged into the re-registration reference. */
export const SESSION_REFERENCE_FRAMES = 100;

/** `[rotation (degrees), dy, dx]`: a session's similarity transform (identity: zeros). */
export type SessionTransform = [number, number, number];

/** What the stages did at the start of a session (on that batch's step result). */
export interface SessionStart {
  /** 1-based session index within the run, and its first frame. */
  index: number;
  frame: number;
  /** The transform applied to the session's frames. */
  transform: SessionTransform;
  /** The best fit before the apply rule, and its correlations (absent in a replay). */
  fitted?: SessionTransform;
  ncc?: number;
  nccUnrotated?: number;
  /**
   * The chance level of `ncc` (the moving image mirrored, the same search)
   * and whether the fit sits at the edge of the rotation grid or the
   * translation search (absent in a replay). For the boundary flags
   * (`boundary-flags.ts`); they change nothing.
   */
  chanceNcc?: number;
  pinnedRotation?: boolean;
  pinnedShift?: boolean;
  /** Background floor map (gain, offset, share kept by the fit) and noise-map factor. */
  floorGain: number;
  floorOffset: number;
  floorKept: number;
  noiseRatio: number;
}

/**
 * The step result's record of a session start: `align` is
 * `SessionAligner.beginSession`'s values (pass 1), `fit`
 * `Preprocessor.beginSessionBack`'s.
 */
export function sessionStart(
  job: { session?: { index: number; frame: number }; sessionAlign?: number[] },
  transform: SessionTransform,
  fit: ArrayLike<number>,
): SessionStart {
  const al = job.sessionAlign;
  return {
    index: job.session!.index,
    frame: job.session!.frame,
    transform,
    ...(al
      ? {
          fitted: [al[3], al[4], al[5]] as SessionTransform,
          ncc: al[6],
          nccUnrotated: al[7],
          ...(al.length >= 11
            ? { chanceNcc: al[8], pinnedRotation: al[9] === 1, pinnedShift: al[10] === 1 }
            : {}),
        }
      : {}),
    floorGain: fit[0],
    floorOffset: fit[1],
    floorKept: fit[2],
    noiseRatio: fit[3],
  };
}

/**
 * The frames of the batch `[start, start + count)` that go into the
 * reference of an upcoming boundary: `[from, to)` relative to `start`, or
 * null.
 */
export function referenceSpan(
  boundaries: readonly number[],
  start: number,
  count: number,
): { from: number; to: number } | null {
  for (const b of boundaries) {
    const lo = Math.max(start, b - SESSION_REFERENCE_FRAMES);
    const hi = Math.min(start + count, b);
    if (lo < hi) return { from: lo - start, to: hi - start };
  }
  return null;
}

export interface SessionHooks {
  /**
   * Session `index` (1-based within the run: 1 is the second session) starts
   * at global frame `frame`, inside the batch about to be processed.
   */
  onSessionBoundary(index: number, frame: number): void;
}

/** The hook that does nothing (no observer). */
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
