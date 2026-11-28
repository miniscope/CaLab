/**
 * Collision-free axis labels: each candidate label is placed inside the drawable span with an
 * anchor that keeps its whole box on the axis, and a label whose box would overlap one already
 * kept (by at least `gap` px) is dropped. Candidates are kept in priority order, then drawn in
 * x order, so pinned labels (a segment's ends) always win over the round ticks between them.
 */

/** One candidate label at `x` px. */
export interface AxisLabelCandidate {
  x: number;
  text: string;
  /** Preferred anchor (default 'middle'); moved inward when the box would leave [x0, x1]. */
  anchor?: 'start' | 'middle' | 'end';
  /** Higher is kept first (default 0). */
  priority?: number;
}

/** A kept label, with the anchor it is drawn with. */
export interface AxisLabel {
  x: number;
  text: string;
  anchor: 'start' | 'middle' | 'end';
}

export interface AxisLabelOptions {
  /** The span labels may occupy, px. */
  x0: number;
  x1: number;
  /** Width of one character, px (an estimate for the label font). Default 6. */
  charPx?: number;
  /** Least space between two labels' boxes, px. Default 6. */
  gap?: number;
}

/** Box [left, right] of a label drawn at `x` with `anchor`. */
function box(x: number, w: number, anchor: AxisLabel['anchor']): [number, number] {
  if (anchor === 'start') return [x, x + w];
  if (anchor === 'end') return [x - w, x];
  return [x - w / 2, x + w / 2];
}

/** The labels to draw (see the module comment), sorted by x. */
export function placeAxisLabels(
  candidates: readonly AxisLabelCandidate[],
  opts: AxisLabelOptions,
): AxisLabel[] {
  const charPx = opts.charPx ?? 6;
  const gap = opts.gap ?? 6;
  const order = candidates
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.text !== '' && Number.isFinite(c.x))
    .sort((a, b) => (b.c.priority ?? 0) - (a.c.priority ?? 0) || a.i - b.i);
  const kept: { label: AxisLabel; l: number; r: number }[] = [];
  for (const { c } of order) {
    const w = c.text.length * charPx;
    let anchor = c.anchor ?? 'middle';
    let [l, r] = box(c.x, w, anchor);
    if (l < opts.x0) anchor = 'start';
    else if (r > opts.x1) anchor = 'end';
    [l, r] = box(c.x, w, anchor);
    if (l < opts.x0 - 0.5 || r > opts.x1 + 0.5) continue;
    if (kept.some((k) => l < k.r + gap && r > k.l - gap)) continue;
    kept.push({ label: { x: c.x, text: c.text, anchor }, l, r });
  }
  return kept.map((k) => k.label).sort((a, b) => a.x - b.x);
}
