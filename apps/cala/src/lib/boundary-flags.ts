/**
 * Session-boundary health flags (Joint runs): did a boundary go well, and if
 * not, why. Observers only: nothing here feeds back into processing.
 *
 * At each boundary the stages re-register the new session, re-seat the
 * flicker reference and rescale the background floor and the noise map
 * (`session-boundary.ts`, `docs/stages.md`). The flags judge three things:
 *
 * - **Alignment** (at the boundary). The re-registration's correlation `ncc`
 *   against its null, the same correlation between a block of 100
 *   registered frames and the next batch within a session
 *   (`SessionAligner.nullSample`), compared on the log decorrelation
 *   `-ln(1 - ncc)`: a warning when it is outside that null;
 *   failed when it is nearer the chance level (the moving image mirrored,
 *   `SessionStart.chanceNcc`) than a within-session match. A fit at the edge
 *   of the rotation grid or the translation search is a warning, failed
 *   when the match is also poor.
 * - **Change** (one window after the boundary). The floor fit must describe
 *   the majority of the pixels (`floorKept`). After the rescale, the noise
 *   level and the background floor should move no more than they do over
 *   the same time within a session (a correction that missed the change
 *   leaves the trackers to follow it).
 * - **Outcome** (one window after the boundary): new cells and existing
 *   cells going silent, against their counts over the same window length
 *   within the sessions before. A burst of either says the library did not
 *   carry over. Failed when the excess is more than half the library (adds)
 *   or half the active cells (silences).
 *
 * Every threshold is a statistic of the recording against a null built
 * from the recording; the fixed numbers are the few principled choices in
 * `BOUNDARY_FLAG_RULES`, documented there.
 */
import { MIN_SNR } from './qc.ts';
import type { SessionStart } from './session-boundary.ts';

/**
 * The fixed choices, in one place (docs/stages.md, "Boundary flags").
 */
export const BOUNDARY_FLAG_RULES = {
  /**
   * Seconds of stream after a boundary the change and outcome checks read
   * (converted with the recording's fps), and the length of the
   * within-session windows they are compared with.
   */
  windowS: 30,
  /**
   * How far outside its null a statistic must be to count: 3.5 robust
   * standard deviations, the outlier cut of Iglewicz & Hoaglin (1993) for
   * the modified z score (median and MAD). Counts use the same cut on a
   * variance-stabilised (Anscombe) scale.
   */
  outsideZ: 3.5,
  /**
   * The majority rule of the "failed" tier: the match keeps under half its
   * margin over chance; the floor fit keeps under half the pixels (the
   * breakdown point of its median-based trimming); the excess new or silent
   * cells pass half the library or half the active cells.
   */
  majority: 0.5,
  /** Fewest null samples with a spread (median and MAD need three). */
  minNull: 3,
} as const;

export type BoundaryRules = typeof BOUNDARY_FLAG_RULES;

export type BoundarySeverity = 'ok' | 'warning' | 'failed';

export type BoundaryCheckKey =
  | 'match'
  | 'search_edge'
  | 'floor_fit'
  | 'noise_drift'
  | 'floor_drift'
  | 'new_cells'
  | 'silent_cells';

export interface BoundaryCheck {
  key: BoundaryCheckKey;
  group: 'alignment' | 'change' | 'outcome';
  severity: BoundarySeverity;
  /** False: not judged (its window has not played yet, or too little data). */
  judged: boolean;
  /** The statistic, its null's centre and spread (NaN where none). */
  value: number;
  nullCentre: number;
  nullSpread: number;
  /** Distance outside the null in its units (positive = worse; NaN when not judged). */
  z: number;
  /** Plain language. */
  reason: string;
}

export interface BoundaryFlag {
  /** 1-based session index within the run (1: the second session) and its first frame. */
  index: number;
  frame: number;
  severity: BoundarySeverity;
  /** Some checks wait for their window after the boundary to play. */
  pending: boolean;
  /** Plain language: the worst checks' reasons (or what went well). */
  reason: string;
  /** What to do about it (failed only). */
  suggestion?: string;
  checks: BoundaryCheck[];
}

export const SEPARATE_SUGGESTION =
  'Run these sessions Separate (a library per session) instead of in one Joint chain.';

const RANK: Record<BoundarySeverity, number> = { ok: 0, warning: 1, failed: 2 };

export function worse(a: BoundarySeverity, b: BoundarySeverity): BoundarySeverity {
  return RANK[a] >= RANK[b] ? a : b;
}

/** The worst severity of `flags` (ok for none). */
export function worstSeverity(flags: readonly { severity: BoundarySeverity }[]): BoundarySeverity {
  return flags.reduce<BoundarySeverity>((s, f) => worse(s, f.severity), 'ok');
}

// ---- Statistics ----

/** Median of the finite values (NaN for none). */
export function median(v: readonly number[]): number {
  const s = v.filter(Number.isFinite).sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return NaN;
  return n % 2 ? s[(n - 1) / 2] : 0.5 * (s[n / 2 - 1] + s[n / 2]);
}

/** -ln(1 - ncc), the scale the match is compared on (higher: better). */
export function logDecorrelation(ncc: number): number {
  return -Math.log(Math.max(1e-6, 1 - ncc));
}

/** Robust standard deviation: 1.4826 × the median absolute deviation. */
export function robustSd(v: readonly number[]): number {
  const m = median(v);
  return 1.4826 * median(v.map((x) => Math.abs(x - m)));
}

/** Robust z of `x` against `sample` (positive above); NaN with fewer than `minNull` samples. */
export function robustZ(x: number, sample: readonly number[], minNull: number): number {
  const s = sample.filter(Number.isFinite);
  if (s.length < minNull || !Number.isFinite(x)) return NaN;
  const m = median(s);
  const sd = robustSd(s);
  if (sd > 0) return (x - m) / sd;
  return x === m ? 0 : x > m ? Infinity : -Infinity;
}

/**
 * Excess of a count `n` over null window counts, on the Anscombe scale
 * (variance-stabilised Poisson, 2√(x + 3/8)), divided by the null's
 * overdispersion (variance over mean, at least 1): about a standard normal
 * z for a Poisson-like count.
 */
export function countZ(n: number, nullCounts: readonly number[]): number {
  const k = nullCounts.length;
  if (k === 0) return NaN;
  const mean = nullCounts.reduce((a, b) => a + b, 0) / k;
  const v = k > 1 ? nullCounts.reduce((a, b) => a + (b - mean) ** 2, 0) / (k - 1) : mean;
  const phi = mean > 0 ? Math.max(1, v / mean) : 1;
  return (2 * (Math.sqrt(n + 3 / 8) - Math.sqrt(mean + 3 / 8))) / Math.sqrt(phi);
}

/**
 * Excess of `s` successes out of `a` over the null's pooled share, as a z
 * with the null's overdispersion (quasi-binomial; the share gets half a
 * success of prior so a null of zeros still has a spread).
 */
export function shareZ(s: number, a: number, nul: readonly { s: number; a: number }[]): number {
  if (nul.length === 0 || a <= 0) return NaN;
  const S = nul.reduce((t, x) => t + x.s, 0);
  const A = nul.reduce((t, x) => t + x.a, 0);
  const p = (S + 0.5) / (A + 1);
  let chi = 0;
  for (const x of nul) if (x.a > 0) chi += (x.s - x.a * p) ** 2 / (x.a * p * (1 - p));
  const phi = nul.length > 1 ? Math.max(1, chi / (nul.length - 1)) : 1;
  return (s - a * p) / Math.sqrt(phi * a * p * (1 - p));
}

// ---- Checks ----

const fmt = (v: number, d = 2): string => (Number.isFinite(v) ? v.toFixed(d) : 'n/a');
const pct = (v: number): string => `${Math.round(100 * v)} %`;

function check(
  key: BoundaryCheckKey,
  group: BoundaryCheck['group'],
  p: Partial<BoundaryCheck> & { reason: string },
): BoundaryCheck {
  return {
    key,
    group,
    severity: 'ok',
    judged: true,
    value: NaN,
    nullCentre: NaN,
    nullSpread: NaN,
    z: NaN,
    ...p,
  };
}

/** What the alignment checks read. */
export interface AlignmentInput {
  start: SessionStart;
  /** Within-session block correlations from the sessions before the boundary. */
  nullNcc: readonly number[];
}

/** The re-registration's match and the search edges (judged at the boundary). */
export function alignmentChecks(i: AlignmentInput, rules: BoundaryRules): BoundaryCheck[] {
  const st = i.start;
  const ncc = st.ncc;
  if (ncc === undefined || !Number.isFinite(ncc))
    return [
      check('match', 'alignment', {
        judged: false,
        reason: 'No re-registration fit to judge (the boundary was replayed or had no reference).',
      }),
    ];
  const nul = i.nullNcc.filter(Number.isFinite);
  const centre = median(nul);
  const spread = robustSd(nul);
  // Positive: the boundary matches worse than within a session. Measured on
  // the log decorrelation -ln(1 - ncc): the within-session correlations
  // have a long low tail (motion blur inside the batch), which is about
  // symmetric on that scale.
  const z = -robustZ(logDecorrelation(ncc), nul.map(logDecorrelation), rules.minNull);
  const chance = st.chanceNcc ?? NaN;
  // Share of a within-session match's margin over chance the boundary keeps.
  const kept =
    Number.isFinite(chance) && Number.isFinite(centre) && centre > chance
      ? (ncc - chance) / (centre - chance)
      : NaN;
  let match: BoundaryCheck;
  const nulls = `within sessions ${fmt(centre)} ± ${fmt(spread, 3)}`;
  if (Number.isFinite(kept) && kept < rules.majority)
    match = check('match', 'alignment', {
      severity: 'failed',
      value: ncc,
      nullCentre: centre,
      nullSpread: spread,
      z,
      reason: `Alignment failed: the new session matches the previous one at NCC ${fmt(ncc)}, nearer chance (${fmt(chance)}) than a match within a session (${fmt(centre)}). The sessions may not show the same field of view.`,
    });
  else if (!Number.isFinite(z))
    match = check('match', 'alignment', {
      judged: false,
      value: ncc,
      nullCentre: centre,
      nullSpread: spread,
      reason: `Match NCC ${fmt(ncc)}; too little of the previous session to judge it (${nul.length} within-session samples, ${rules.minNull} needed).`,
    });
  else if (z >= rules.outsideZ)
    match = check('match', 'alignment', {
      severity: 'warning',
      value: ncc,
      nullCentre: centre,
      nullSpread: spread,
      z,
      reason: `The new session matches the previous one less well than frames within a session do (NCC ${fmt(ncc)}; ${nulls}).`,
    });
  else
    match = check('match', 'alignment', {
      value: ncc,
      nullCentre: centre,
      nullSpread: spread,
      z,
      reason: `Aligned: NCC ${fmt(ncc)} (${nulls}).`,
    });
  const out = [match];
  if (st.pinnedRotation || st.pinnedShift) {
    const what = [
      st.pinnedRotation ? `rotation (${fmt(st.fitted?.[0] ?? NaN, 1)}°)` : '',
      st.pinnedShift ? 'translation' : '',
    ]
      .filter(Boolean)
      .join(' and ');
    out.push(
      check('search_edge', 'alignment', {
        severity: match.severity === 'ok' || !match.judged ? 'warning' : 'failed',
        value: 1,
        reason: `The re-registration's best ${what} is at the edge of its search (±3°, ±40 px): the new session may have moved further than cala searches.`,
      }),
    );
  }
  return out;
}

/** One within-session or boundary window's measurements. */
export interface WindowStats {
  /** Its first frame and length. */
  start: number;
  frames: number;
  /** Slow-loop adds in it. */
  adds: number;
  /** ln(noise at the end / at the start), and the floor's move in noise σ. */
  noiseDrift: number;
  floorDrift: number;
  /** Boundary window: the floor's step at the boundary (last summary before it to first after), noise σ. */
  floorStep?: number;
  /** Cells active in the window before and of those, silent or gone in this one (transition windows). */
  active?: number;
  silenced?: number;
}

/** What the change and outcome checks read (judged once the window after the boundary played). */
export interface OutcomeInput {
  start: SessionStart;
  /** The window after the boundary (null: not played yet). */
  after: WindowStats | null;
  /** Cells in the library at the boundary. */
  cells: number;
  /** Windows within the sessions before the boundary (warm-up windows excluded). */
  nul: readonly WindowStats[];
  windowS: number;
}

export function changeChecks(i: OutcomeInput, rules: BoundaryRules): BoundaryCheck[] {
  const st = i.start;
  const kept = st.floorKept;
  const step = `brightness (floor) ×${fmt(st.floorGain, 3)}, noise ×${fmt(st.noiseRatio, 3)}`;
  const out: BoundaryCheck[] = [];
  // A fit that keeps no pixels at all is the identity fallback: nothing was fitted.
  if (kept > 0 && kept < rules.majority)
    out.push(
      check('floor_fit', 'change', {
        severity: 'failed',
        value: kept,
        reason: `The brightness change is not one the floor rescale can describe: its fit follows only ${pct(kept)} of the pixels (${step}).`,
      }),
    );
  else
    out.push(
      check('floor_fit', 'change', {
        value: kept,
        reason: `Brightness change corrected: ${step} (the fit follows ${pct(kept)} of the pixels).`,
      }),
    );
  const w = `${i.windowS} s`;
  if (!i.after) {
    out.push(
      check('noise_drift', 'change', {
        judged: false,
        reason: `Waits for ${w} after the boundary.`,
      }),
    );
    return out;
  }
  const a = i.after;
  // A drift warns when it is outside the within-session null AND larger than
  // the step the rescale applied at the boundary (the majority rule: the
  // correction captured under half of the change). The trackers settle a
  // little after any boundary, which a tight within-session null alone
  // would read as a failure.
  const drift = (
    key: 'noise_drift' | 'floor_drift',
    value: number,
    step: number,
    nul: number[],
    say: (v: number) => string,
    what: string,
  ): BoundaryCheck => {
    const z = Math.abs(robustZ(value, nul, rules.minNull));
    if (!Number.isFinite(z))
      return check(key, 'change', {
        judged: false,
        value,
        reason: `Too little within-session data to judge the ${what} after the boundary (${i.nul.length} windows of ${w}, ${rules.minNull} needed).`,
      });
    const bad = z >= rules.outsideZ && Math.abs(value) > Math.abs(step);
    return check(key, 'change', {
      severity: bad ? 'warning' : 'ok',
      value,
      nullCentre: median(nul),
      nullSpread: robustSd(nul),
      z,
      reason: bad
        ? `The ${what} kept changing after the boundary (${say(value)} over ${w}, more than the rescale's ${say(step)}; within sessions ${say(median(nul))} ± ${fmt(robustSd(nul), 3)}): the rescale did not capture the change.`
        : `The ${what} held after the rescale (${say(value)} over ${w}).`,
    });
  };
  out.push(
    drift(
      'noise_drift',
      a.noiseDrift,
      Math.log(i.start.noiseRatio),
      i.nul.map((x) => x.noiseDrift),
      (v) => `×${fmt(Math.exp(v), 3)}`,
      'noise level',
    ),
  );
  if (Number.isFinite(a.floorStep ?? NaN))
    out.push(
      drift(
        'floor_drift',
        a.floorDrift,
        a.floorStep!,
        i.nul.map((x) => x.floorDrift),
        (v) => `${fmt(v)} noise σ`,
        'background floor',
      ),
    );
  return out;
}

export function outcomeChecks(i: OutcomeInput, rules: BoundaryRules): BoundaryCheck[] {
  const w = `${i.windowS} s`;
  if (!i.after)
    return [
      check('new_cells', 'outcome', {
        judged: false,
        reason: `Waits for ${w} after the boundary.`,
      }),
    ];
  const a = i.after;
  const out: BoundaryCheck[] = [];
  const nAdds = i.nul.map((x) => x.adds);
  const meanAdds = nAdds.length ? nAdds.reduce((s, x) => s + x, 0) / nAdds.length : NaN;
  if (nAdds.length < rules.minNull)
    out.push(
      check('new_cells', 'outcome', {
        judged: false,
        value: a.adds,
        reason: `Too little within-session data to judge the new cells after the boundary (${nAdds.length} windows of ${w}, ${rules.minNull} needed).`,
      }),
    );
  else {
    const z = countZ(a.adds, nAdds);
    const excess = a.adds - meanAdds;
    const sev: BoundarySeverity =
      z >= rules.outsideZ ? (excess > rules.majority * i.cells ? 'failed' : 'warning') : 'ok';
    out.push(
      check('new_cells', 'outcome', {
        severity: sev,
        value: a.adds,
        nullCentre: meanAdds,
        nullSpread: robustSd(nAdds),
        z,
        reason:
          sev === 'ok'
            ? `${a.adds} cells added in the ${w} after the boundary (within sessions ${fmt(meanAdds, 1)} per ${w}).`
            : `${a.adds} cells were added in the ${w} after the boundary, against ${fmt(meanAdds, 1)} per ${w} within sessions${sev === 'failed' ? `, more than half the library (${i.cells})` : ''}: the library did not carry over well.`,
      }),
    );
  }
  const trans = i.nul.filter((x) => x.active !== undefined && x.silenced !== undefined);
  if (a.active === undefined || a.silenced === undefined || trans.length < rules.minNull)
    out.push(
      check('silent_cells', 'outcome', {
        judged: false,
        reason: `Too little within-session data to judge cells going silent (${trans.length} windows, ${rules.minNull} needed).`,
      }),
    );
  else {
    const nul = trans.map((x) => ({ s: x.silenced!, a: x.active! }));
    const z = shareZ(a.silenced, a.active, nul);
    const S = nul.reduce((t, x) => t + x.s, 0);
    const A = nul.reduce((t, x) => t + x.a, 0);
    const share = A > 0 ? S / A : NaN;
    const excess = a.silenced - a.active * (Number.isFinite(share) ? share : 0);
    const sev: BoundarySeverity =
      z >= rules.outsideZ ? (excess > rules.majority * a.active ? 'failed' : 'warning') : 'ok';
    out.push(
      check('silent_cells', 'outcome', {
        severity: sev,
        value: a.active > 0 ? a.silenced / a.active : NaN,
        nullCentre: share,
        z,
        reason:
          sev === 'ok'
            ? `${a.silenced} of ${a.active} active cells went silent after the boundary (within sessions ${pct(share)}).`
            : `${a.silenced} of ${a.active} active cells went silent at once after the boundary, against ${pct(share)} within sessions${sev === 'failed' ? ' (more than half)' : ''}: the library did not carry over well.`,
      }),
    );
  }
  return out;
}

/** The flag from its checks. */
export function summarize(
  index: number,
  frame: number,
  checks: BoundaryCheck[],
  pending = false,
): BoundaryFlag {
  const severity = worstSeverity(checks);
  const bad = checks.filter((c) => c.severity === severity && severity !== 'ok');
  const reason =
    severity === 'ok'
      ? checks
          .filter((c) => c.judged && (c.key === 'match' || c.key === 'floor_fit'))
          .map((c) => c.reason)
          .join(' ') || 'No problem found.'
      : bad.map((c) => c.reason).join(' ');
  return {
    index,
    frame,
    severity,
    pending,
    reason:
      pending && severity === 'ok' ? `${reason} The outcome checks wait for their window.` : reason,
    ...(severity === 'failed' ? { suggestion: SEPARATE_SUGGESTION } : {}),
    checks,
  };
}

// ---- The monitor: collects what the checks read during Discover ----

/** A cell's summary over one window. */
interface CellWindow {
  max: number;
  median: number;
  /** Noise σ from the MAD of first differences over pairs where the trace is above 0 (NaN: too few). */
  sigma: number;
}

/** Robust σ of a trace from its first differences, over pairs off the clip at 0. */
export function traceSigma(x: ArrayLike<number>): number {
  const d: number[] = [];
  for (let i = 1; i < x.length; i++)
    if (x[i] > 0 && x[i - 1] > 0 && Number.isFinite(x[i]) && Number.isFinite(x[i - 1]))
      d.push(Math.abs(x[i] - x[i - 1]));
  if (d.length < 10) return NaN;
  return (1.4826 * median(d)) / Math.SQRT2;
}

/** Active over a window (QC's pass rule: peak SNR ≥ 5), its noise σ from `sigma`. */
export function isActive(w: CellWindow | undefined, sigma: number): boolean {
  if (!w || !(sigma > 0)) return false;
  return (w.max - w.median) / sigma >= MIN_SNR;
}

interface OpenWindow {
  start: number;
  end: number;
  samples: Map<number, number[]>;
  closed: Map<number, CellWindow> | null;
  /** Cells in the batch holding the window's last frame. */
  lastIds: Set<number>;
}

export interface MonitorOptions {
  /** First frames of sessions 1.. on the run's axis. */
  boundaries: readonly number[];
  /** Frames in the run. */
  frames: number;
  fps: number;
  rules?: BoundaryRules;
}

/**
 * Collects, during Discover of a Joint run, what the boundary checks read
 * and judges each boundary: alignment at once, change and outcome once the
 * window after it has played. Pure and synchronous (fed by the pipeline
 * store), so it is unit-tested directly.
 */
export class BoundaryMonitor {
  readonly rules: BoundaryRules;
  readonly window: number;
  private readonly starts: number[];
  private readonly ends: number[];
  private readonly nulls: { frame: number; ncc: number }[] = [];
  private readonly sessionStarts = new Map<number, SessionStart>();
  private readonly imaging: { frame: number; noise: number; floor: number }[] = [];
  private readonly adds: { frame: number; total: number }[] = [];
  private readonly windows = new Map<string, OpenWindow>();
  private readonly cellsAt = new Map<number, number>();
  private fastFrame = 0;
  private slowFrame = 0;
  private ended = false;
  /** Ends of every window a check reads, ascending (`changed`). */
  private readonly windowEnds: number[];
  private signature = '';

  constructor(o: MonitorOptions) {
    this.rules = o.rules ?? BOUNDARY_FLAG_RULES;
    this.window = Math.max(1, Math.round(this.rules.windowS * (o.fps > 0 ? o.fps : 20)));
    this.starts = [0, ...o.boundaries];
    this.ends = [...o.boundaries, o.frames];
    // Windows of traces kept: aligned windows j >= 1 of every session, the
    // window before each boundary and the first window of each later session.
    const W = this.window;
    for (let s = 0; s < this.starts.length; s++) {
      for (let j = 1; this.starts[s] + (j + 1) * W <= this.ends[s]; j++)
        this.addWindow(`s${s}w${j}`, this.starts[s] + j * W, this.starts[s] + (j + 1) * W);
      if (s > 0) {
        const b = this.starts[s];
        this.addWindow(`pre${s}`, Math.max(this.starts[s - 1], b - W), b);
        this.addWindow(`s${s}w0`, b, Math.min(this.ends[s], b + W));
      }
    }
    this.windowEnds = [...this.windows.values()].map((w) => w.end).sort((a, b) => a - b);
  }

  /**
   * True when the flags may read differently than at the last call that
   * returned true: a session started, a window finished playing (in the
   * fast and the slow loop), or Discover ended. Cheap: call it per batch.
   */
  changed(): boolean {
    const done = Math.min(this.fastFrame, this.ended ? Infinity : this.slowFrame);
    let n = 0;
    while (n < this.windowEnds.length && this.windowEnds[n] <= done) n++;
    const sig = `${this.sessionStarts.size}/${n}/${this.ended}`;
    if (sig === this.signature) return false;
    this.signature = sig;
    return true;
  }

  private addWindow(key: string, start: number, end: number): void {
    if (end > start)
      this.windows.set(key, { start, end, samples: new Map(), closed: null, lastIds: new Set() });
  }

  /** Session of frame `f`. */
  private sessionOf(f: number): number {
    let s = 0;
    while (s + 1 < this.starts.length && f >= this.starts[s + 1]) s++;
    return s;
  }

  /** A within-session sample of the boundary correlation's null, completed at `frame`. */
  onNull(frame: number, ncc: number): void {
    if (Number.isFinite(ncc)) this.nulls.push({ frame, ncc });
  }

  onSessionStart(st: SessionStart): void {
    this.sessionStarts.set(st.index, st);
  }

  /** The FOV's median noise σ and background floor at `frame` (`ImagingStats`). */
  onImaging(frame: number, noise: number, floor: number): void {
    if (Number.isFinite(noise) && noise > 0 && Number.isFinite(floor))
      this.imaging.push({ frame, noise, floor });
  }

  /** The slow loop's cumulative adds at its stream frame `frame`. */
  onAdds(frame: number, total: number): void {
    if (!Number.isFinite(frame) || !Number.isFinite(total)) return;
    this.adds.push({ frame, total });
    this.slowFrame = Math.max(this.slowFrame, frame);
  }

  /** The fast loop's traces of frames `[start, start + count)`: `ids.length` per frame. */
  onTraces(start: number, count: number, ids: ArrayLike<number>, traces: ArrayLike<number>): void {
    const n = ids.length;
    const end = start + count;
    for (const b of this.starts.slice(1)) if (b >= start && b < end) this.cellsAt.set(b, n);
    for (const w of this.windows.values()) {
      if (w.closed || end <= w.start || start >= w.end) continue;
      const a = Math.max(start, w.start);
      const z = Math.min(end, w.end);
      for (let k = 0; k < n; k++) {
        const id = ids[k];
        let s = w.samples.get(id);
        if (!s) w.samples.set(id, (s = []));
        for (let f = a; f < z; f++) s.push(traces[(f - start) * n + k]);
      }
      if (z === w.end) {
        w.lastIds = new Set(Array.from({ length: n }, (_, k) => ids[k]));
        w.closed = new Map();
        for (const [id, s] of w.samples) {
          w.closed.set(id, { max: Math.max(...s), median: median(s), sigma: traceSigma(s) });
        }
        w.samples = new Map();
      }
    }
    this.fastFrame = Math.max(this.fastFrame, end);
  }

  /** Discover ended: judge with what there is (windows the run did not reach stay unjudged). */
  end(): void {
    this.ended = true;
  }

  private addsAt(frame: number): number {
    let v = 0;
    for (const a of this.adds) {
      if (a.frame > frame) break;
      v = a.total;
    }
    return v;
  }

  private imagingIn(start: number, end: number) {
    const inside = this.imaging.filter((x) => x.frame >= start && x.frame < end);
    return inside.length >= 2 ? { first: inside[0], last: inside[inside.length - 1] } : null;
  }

  /** The window's stats, or null when it has not fully played (fast and slow loop). */
  private stats(
    start: number,
    end: number,
    before?: OpenWindow,
    after?: OpenWindow,
  ): WindowStats | null {
    if (this.fastFrame < end || (this.slowFrame < end && !this.ended)) return null;
    const im = this.imagingIn(start, end);
    const s: WindowStats = {
      start,
      frames: end - start,
      adds: this.addsAt(end) - this.addsAt(start),
      noiseDrift: im ? Math.log(im.last.noise / im.first.noise) : NaN,
      floorDrift: im ? (im.last.floor - im.first.floor) / im.first.noise : NaN,
    };
    if (before?.closed && after?.closed) {
      let active = 0;
      let silenced = 0;
      for (const id of before.lastIds) {
        const b = before.closed.get(id);
        const sigma = b?.sigma ?? NaN;
        if (!isActive(b, sigma)) continue;
        active++;
        const a = after.closed.get(id);
        if (!a || !after.lastIds.has(id) || !isActive(a, sigma)) silenced++;
      }
      s.active = active;
      s.silenced = silenced;
    }
    return s;
  }

  /** The judged within-session windows of sessions `0..session-1` (warm-up excluded: aligned j >= 2). */
  private nullWindows(session: number): WindowStats[] {
    const out: WindowStats[] = [];
    const W = this.window;
    for (let s = 0; s < session; s++)
      for (let j = 2; this.starts[s] + (j + 1) * W <= this.ends[s]; j++) {
        const st = this.stats(
          this.starts[s] + j * W,
          this.starts[s] + (j + 1) * W,
          this.windows.get(`s${s}w${j - 1}`),
          this.windows.get(`s${s}w${j}`),
        );
        if (st) out.push(st);
      }
    return out;
  }

  /** Every boundary reached so far, judged with what there is now. */
  flags(): BoundaryFlag[] {
    const out: BoundaryFlag[] = [];
    for (const [index, st] of [...this.sessionStarts].sort((a, b) => a[0] - b[0])) {
      const b = st.frame;
      const session = this.sessionOf(b);
      const nullNcc = this.nulls.filter((x) => x.frame < b).map((x) => x.ncc);
      const checks = alignmentChecks({ start: st, nullNcc }, this.rules);
      const end = Math.min(this.ends[session], b + this.window);
      const full = end - b === this.window && b - this.starts[session - 1] >= this.window;
      const after = full
        ? this.stats(b, end, this.windows.get(`pre${session}`), this.windows.get(`s${session}w0`))
        : null;
      if (after) {
        const before = this.imaging.filter((x) => x.frame < b).at(-1);
        const first = this.imaging.find((x) => x.frame >= b);
        if (before && first) after.floorStep = (first.floor - before.floor) / before.noise;
      }
      const pending = full && !after && !this.ended;
      const input: OutcomeInput = {
        start: st,
        after,
        cells: this.cellsAt.get(b) ?? 0,
        nul: this.nullWindows(session),
        windowS: this.rules.windowS,
      };
      checks.push(...changeChecks(input, this.rules), ...outcomeChecks(input, this.rules));
      if (!full)
        for (const c of checks)
          if (/^Waits/.test(c.reason))
            c.reason = `Not judged: a session around this boundary is shorter than ${this.rules.windowS} s.`;
      if (this.ended)
        for (const c of checks)
          if (/^Waits/.test(c.reason))
            c.reason = 'Not judged: the run ended before the window played.';
      out.push(summarize(index, b, checks, pending));
    }
    return out;
  }
}

// ---- Persistence (export meta_json.session.boundary, cala-session.json, the project index) ----

/** The JSON form (snake_case, as the export's metadata). */
export function boundaryFlagJson(f: BoundaryFlag): Record<string, unknown> {
  const num = (v: number) => (Number.isFinite(v) ? v : null);
  return {
    session_index: f.index,
    frame: f.frame,
    severity: f.severity,
    pending: f.pending,
    reason: f.reason,
    ...(f.suggestion ? { suggestion: f.suggestion } : {}),
    checks: f.checks.map((c) => ({
      key: c.key,
      group: c.group,
      severity: c.severity,
      judged: c.judged,
      value: num(c.value),
      null_centre: num(c.nullCentre),
      null_spread: num(c.nullSpread),
      z: Number.isFinite(c.z) ? c.z : c.z === Infinity ? 'inf' : null,
      reason: c.reason,
    })),
  };
}

const SEVERITIES: readonly BoundarySeverity[] = ['ok', 'warning', 'failed'];

/** Read the JSON form back (null when it is not one). */
export function parseBoundaryFlag(v: unknown): BoundaryFlag | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (!SEVERITIES.includes(o.severity as BoundarySeverity)) return null;
  const n = (x: unknown) => (typeof x === 'number' ? x : x === 'inf' ? Infinity : NaN);
  const checks = Array.isArray(o.checks)
    ? o.checks.flatMap((c): BoundaryCheck[] => {
        if (!c || typeof c !== 'object') return [];
        const r = c as Record<string, unknown>;
        if (!SEVERITIES.includes(r.severity as BoundarySeverity)) return [];
        return [
          {
            key: String(r.key) as BoundaryCheckKey,
            group: (r.group as BoundaryCheck['group']) ?? 'alignment',
            severity: r.severity as BoundarySeverity,
            judged: r.judged !== false,
            value: n(r.value),
            nullCentre: n(r.null_centre),
            nullSpread: n(r.null_spread),
            z: n(r.z),
            reason: typeof r.reason === 'string' ? r.reason : '',
          },
        ];
      })
    : [];
  return {
    index: typeof o.session_index === 'number' ? o.session_index : 0,
    frame: typeof o.frame === 'number' ? o.frame : 0,
    severity: o.severity as BoundarySeverity,
    pending: o.pending === true,
    reason: typeof o.reason === 'string' ? o.reason : '',
    ...(typeof o.suggestion === 'string' ? { suggestion: o.suggestion } : {}),
    checks,
  };
}

/** Short label of a severity for badges. */
export function severityLabel(s: BoundarySeverity, pending = false): string {
  if (s === 'failed') return 'Boundary failed';
  if (s === 'warning') return 'Boundary warning';
  return pending ? 'Boundary ok so far' : 'Boundary ok';
}
