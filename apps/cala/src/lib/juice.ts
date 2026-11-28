/**
 * Game-style "juice" of the run rail, tied to the run's real state: where the running bar's
 * leading edge is (its embers) and where each stage's segment ends (the sparks when it
 * finishes), and when the run is going fast enough for the bar to run hot. Pure, unit-tested.
 * The look is in `styles/delight.css`, behind the Fun touches switch.
 */
import { stageFill, type StageSegment } from '@calab/ui';

/** An unpaced (Max) stage runs hot at or above this speed, fps. */
export const HOT_FPS = 150;
/** A paced Discover runs hot at or above this share of its target. */
export const HOT_SHARE = 0.95;

/**
 * True when the running stage is going fast: at or near its target when paced, or above
 * `HOT_FPS` unpaced. Never while nothing runs or the speed is unmeasured.
 */
export function isHot(step: string | null, fps: number | null, target: number | null): boolean {
  if (step === null || fps === null || !Number.isFinite(fps) || fps <= 0) return false;
  if (target !== null && target > 0) return fps >= HOT_SHARE * target;
  return fps >= HOT_FPS;
}

/**
 * Positions along the stage track, as shares of its width (segments sized by weight, the 2 px
 * gaps ignored): `lead`, the running segment's fill end (null when none runs with a known end),
 * and `ends`, each segment's right end.
 */
export function trackEdges(segs: readonly StageSegment[]): {
  lead: number | null;
  ends: { id: string; at: number }[];
} {
  const total = segs.reduce((a, s) => a + (s.weight > 0 ? s.weight : 0), 0) || 1;
  let x = 0;
  let lead: number | null = null;
  const ends: { id: string; at: number }[] = [];
  for (const s of segs) {
    const w = (s.weight > 0 ? s.weight : 0) / total;
    if (s.state === 'running' && s.fraction !== null) lead = x + w * stageFill(s);
    x += w;
    ends.push({ id: s.id, at: x });
  }
  return { lead, ends };
}
