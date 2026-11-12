/**
 * The run's history over stream time: one `StreamHistory` (bounded,
 * multi-resolution bins) and one `RunEvents` log per pass-1 run, fed from
 * messages that already arrive (batch results, QC snapshots, flat-field maps,
 * live counters) and read by the History view, the Run panel and the export.
 *
 * Every series has a declared range from physics or biology, never from the
 * data (see `SERIES`); a range steps up once, visibly, when a closed bin falls
 * outside it, and each step is logged as a `range` event.
 */
import { createSignal } from 'solid-js';
import { StreamHistory, type SeriesSpec } from '@calab/compute';
import { RunEvents, type RunEvent } from './run-events.ts';

/** Motion record flag bits (crates/cala/src/motion/corrector.rs) that count as a flagged frame. */
const MOTION_FLAG_ANOMALOUS = 2;
const MOTION_FLAG_HELD = 4;
const MOTION_FLAG_BRIGHTNESS_OUTLIER = 16;
const MOTION_FLAG_LOW_QUALITY = 32;
const FLAGGED =
  MOTION_FLAG_ANOMALOUS |
  MOTION_FLAG_HELD |
  MOTION_FLAG_BRIGHTNESS_OUTLIER |
  MOTION_FLAG_LOW_QUALITY;

export type HistoryGroup = 'convergence' | 'scales' | 'imaging' | 'motion' | 'throughput';

/** Display order and names of the History groups (the Run panel shows convergence). */
export const HISTORY_GROUPS: { id: HistoryGroup; label: string }[] = [
  { id: 'convergence', label: 'Convergence' },
  { id: 'scales', label: 'Scales' },
  { id: 'imaging', label: 'Imaging' },
  { id: 'motion', label: 'Motion' },
  { id: 'throughput', label: 'Throughput' },
];

type Spec = Omit<SeriesSpec, 'group'>;

/** Okabe-Ito (as `OKABE_ITO` in @calab/ui/chart; repeated so this store stays free of UI imports). */
const C = {
  black: '#000000',
  orange: '#e69f00',
  skyBlue: '#56b4e9',
  bluishGreen: '#009e73',
  blue: '#0072b2',
  vermillion: '#d55e00',
  reddishPurple: '#cc79a7',
} as const;

/**
 * The series of each group, at most six, each with its own Okabe-Ito hue.
 * Initial ranges are DESIGN §3.5; they never come from the data.
 */
const SERIES: Record<HistoryGroup, Spec[]> = {
  convergence: [
    {
      key: 'cells',
      label: 'Cells in the library',
      short: 'Cells',
      unit: 'cells',
      kind: 'value',
      range: [0, 200],
      rangeRule: 'ladder125',
      color: C.blue,
      digits: 0,
      hint: 'Cells in the library the fast loop solves.',
    },
    {
      key: 'new_per_min',
      label: 'New cells per minute',
      short: 'New',
      unit: '/min',
      kind: 'value',
      range: [0, 50],
      rangeRule: 'ladder125',
      color: C.bluishGreen,
      digits: 1,
      hint: 'Cells added where nothing was just removed, per minute of stream (last minute). It slows but need not reach zero.',
    },
    {
      key: 'churn_per_min',
      label: 'Churn per minute',
      short: 'Churn',
      unit: '/min',
      kind: 'value',
      range: [0, 10],
      rangeRule: 'ladder125',
      color: C.orange,
      digits: 1,
      hint: 'Spurious edits per minute of stream: re-adds + adds removed again within 2 min + established cells merged or deleted (each also exported). Should die out; it feeds the status.',
    },
    {
      key: 'stable',
      label: 'Stable share of cells',
      short: 'Stable',
      unit: '',
      kind: 'value',
      range: [0, 1],
      rangeRule: 'fixed',
      color: C.reddishPurple,
      digits: 2,
      hint: 'Share of cells older than 2 min whose footprint (cosine >= 0.95) and trace noise (within 10%) match 1-2 min ago. Should rise to a plateau; it feeds the status.',
    },
    {
      key: 'explained',
      label: 'Explained variance',
      short: 'Explained',
      unit: '',
      kind: 'value',
      range: [0, 1],
      rangeRule: 'fixed',
      color: C.skyBlue,
      digits: 2,
      hint: 'Share of the signal variance above noise that the model explains.',
    },
    {
      key: 'residual_excess',
      label: 'Residual excess',
      short: 'Residual',
      unit: 'x noise',
      kind: 'value',
      range: [0, 5],
      rangeRule: 'ladder125',
      color: C.vermillion,
      digits: 2,
      hint: 'Residual variance above noise, averaged over the field of view. Falls as the model explains more.',
    },
  ],
  // Scale estimates (cell diameter, PSF, flatten σ) arrive with S2.4.
  scales: [],
  imaging: [
    {
      key: 'noise_sigma',
      label: 'Noise σ (median over the FOV)',
      short: 'Noise',
      unit: 'grey',
      kind: 'value',
      range: [0, 5],
      rangeRule: 'ladder125',
      color: C.blue,
      digits: 2,
      hint: 'Per-pixel noise σ (MAD of frame-to-frame differences, the SNR convention), median over the FOV.',
    },
    {
      key: 'background',
      label: 'Background (median over the FOV)',
      short: 'Background',
      unit: 'grey',
      kind: 'value',
      range: [0, 100],
      rangeRule: 'ladder125',
      color: C.orange,
      digits: 1,
      hint: 'Background floor removed by preprocessing, median over the FOV.',
    },
    {
      key: 'flicker_gain',
      label: 'Flicker gain m',
      short: 'Gain',
      unit: '%',
      kind: 'value',
      range: [-5, 5],
      rangeRule: 'ladder125',
      color: C.bluishGreen,
      digits: 2,
      hint: 'Global LED gain removed per frame, relative to the last ~second.',
    },
    {
      key: 'flicker_offset',
      label: 'Flicker offset a',
      short: 'Offset',
      unit: 'grey',
      kind: 'value',
      range: [-2, 2],
      rangeRule: 'ladder125',
      color: C.reddishPurple,
      digits: 2,
      hint: 'Global sensor offset removed per frame, relative to the last ~second.',
    },
    {
      key: 'flat_change',
      label: 'Flat-field update (change)',
      short: 'Flat field',
      unit: '%',
      kind: 'stem',
      range: [0, 5],
      rangeRule: 'ladder125',
      color: C.black,
      digits: 2,
      hint: 'Change of the sensor flat field at each new map (median relative change).',
    },
  ],
  motion: [
    {
      key: 'shift_dy',
      label: 'Rigid shift dy',
      short: 'dy',
      unit: 'px',
      kind: 'value',
      range: [-10, 10],
      rangeRule: 'ladder125',
      color: C.blue,
      digits: 2,
      hint: 'Registering shift per frame, rows.',
    },
    {
      key: 'shift_dx',
      label: 'Rigid shift dx',
      short: 'dx',
      unit: 'px',
      kind: 'value',
      range: [-10, 10],
      rangeRule: 'ladder125',
      color: C.vermillion,
      digits: 2,
      hint: 'Registering shift per frame, columns.',
    },
    {
      key: 'motion_flagged',
      label: 'Frames flagged',
      short: 'Flagged',
      unit: '%',
      kind: 'value',
      range: [0, 100],
      rangeRule: 'fixed',
      color: C.orange,
      digits: 1,
      hint: 'Share of frames flagged by motion correction (low quality, anomalous, held or brightness outlier).',
    },
    {
      key: 'motion_quality',
      label: 'Registration quality',
      short: 'Quality',
      unit: '',
      kind: 'value',
      range: [0, 1],
      rangeRule: 'ladder125',
      color: C.bluishGreen,
      digits: 2,
      hint: 'Correlation peak quality of the registration per frame.',
    },
  ],
  throughput: [
    {
      key: 'proc_fps',
      label: 'Processing rate',
      short: 'Rate',
      unit: 'fps',
      kind: 'value',
      range: [0, 120],
      rangeRule: 'ladder125',
      color: C.blue,
      digits: 1,
      hint: 'Frames processed per second of wall time (3 s window).',
    },
    {
      key: 'slow_lag',
      label: 'Slow-loop lag',
      short: 'Lag',
      unit: 's',
      kind: 'value',
      range: [0, 60],
      rangeRule: 'ladder125',
      color: C.orange,
      digits: 1,
      hint: 'Seconds of stream the slow loop (discovery) is behind the fast loop.',
    },
    {
      key: 'live_dropped',
      label: 'Frames dropped (live)',
      short: 'Dropped',
      unit: '/min',
      kind: 'rate',
      range: [0, 50],
      rangeRule: 'ladder125',
      color: C.vermillion,
      digits: 0,
      hint: 'Live frames dropped or missed at the source, per minute.',
    },
    {
      key: 'live_lag',
      label: 'Live lag',
      short: 'Live lag',
      unit: 's',
      kind: 'value',
      range: [0, 10],
      rangeRule: 'ladder125',
      color: C.skyBlue,
      digits: 2,
      hint: 'How far processing is behind the live stream, seconds.',
    },
  ],
};

/** Series kept for the export and readouts but not drawn as chips. */
const EXTRA: SeriesSpec[] = [
  {
    key: 'working_set',
    label: 'Slow-loop working set',
    unit: 'cells',
    group: 'extra',
    kind: 'value',
    range: [0, 200],
    rangeRule: 'ladder125',
    color: C.bluishGreen,
    digits: 0,
  },
  ...(['reAdds', 'churned', 'establishedRemovals'] as const).map((k): SeriesSpec => ({
    key: `churn_${k === 'reAdds' ? 'readds' : k === 'churned' ? 'removed_again' : 'established'}`,
    label: `Churn: ${k === 'reAdds' ? 're-adds' : k === 'churned' ? 'adds removed again' : 'established cells removed'}`,
    unit: '/min',
    group: 'extra',
    kind: 'value',
    range: [0, 10],
    rangeRule: 'ladder125',
    color: C.orange,
    digits: 1,
  })),
  {
    key: 'fp_cosine',
    label: 'Median footprint cosine',
    unit: '',
    group: 'extra',
    kind: 'value',
    range: [0, 1],
    rangeRule: 'fixed',
    color: C.reddishPurple,
    digits: 2,
  },
  {
    key: 'snr_median',
    label: 'Median peak SNR',
    unit: '',
    group: 'extra',
    kind: 'value',
    range: [0, 20],
    rangeRule: 'ladder125',
    color: C.blue,
    digits: 1,
  },
  {
    key: 'pass_frac',
    label: 'QC pass share',
    unit: '',
    group: 'extra',
    kind: 'value',
    range: [0, 1],
    rangeRule: 'fixed',
    color: C.blue,
    digits: 2,
  },
  {
    key: 'fast_ms',
    label: 'Fast loop per frame',
    unit: 'ms',
    group: 'extra',
    kind: 'value',
    range: [0, 50],
    rangeRule: 'ladder125',
    color: C.blue,
    digits: 1,
  },
  {
    key: 'wall_s',
    label: 'Wall clock since the run started',
    unit: 's',
    group: 'extra',
    kind: 'value',
    range: [0, 1],
    rangeRule: 'double',
    color: C.black,
    digits: 0,
  },
];

/** Series keys of a group, in chip order (live-only series left out of file runs). */
export function groupKeys(group: HistoryGroup, live: boolean): string[] {
  return SERIES[group]
    .map((s) => s.key)
    .filter((k) => live || (k !== 'live_dropped' && k !== 'live_lag'));
}

/** Every series spec (all groups, then the extras), as registered. */
export function allSeries(): SeriesSpec[] {
  return [
    ...HISTORY_GROUPS.flatMap((g) => SERIES[g.id].map((s) => ({ ...s, group: g.id }))),
    ...EXTRA,
  ];
}

/** One QC snapshot's numbers, as the convergence history gets them. */
export interface ConvergenceSample {
  cells: number;
  explained: number;
  residualExcess: number;
  stableFrac: number;
  fpStability: number;
  snrMedian: number;
  passFrac: number;
  edits: { newAdds: number; reAdds: number; churned: number; establishedRemovals: number };
}

/** What a pipeline batch tells the history (a subset of `PipelineStepResult`). */
export interface HistoryBatch {
  start: number;
  count: number;
  dy: ArrayLike<number>;
  dx: ArrayLike<number>;
  quality: ArrayLike<number>;
  flags: ArrayLike<number>;
  flickerOffset: ArrayLike<number>;
  flickerGain: ArrayLike<number>;
  imaging?: { frame: number; noiseSigma: number; background: number };
}

export function createRunHistory(clock: () => number = () => Date.now()) {
  let history = new StreamHistory();
  let events = new RunEvents();
  let fps = 20;
  let live = false;
  let wall0 = clock();
  let processedS = 0;
  let lastDropped = 0;
  let gapPending = 0;
  let lastGapT = -Infinity;
  const [tick, setTick] = createSignal(0);
  const [runEnd, setRunEnd] = createSignal<number | null>(null);
  /** Bumped when a group gains something to look at (a range step or a warning). */
  const [attention, setAttention] = createSignal<ReadonlySet<string>>(new Set());

  const bump = () => setTick((v) => v + 1);

  function flag(group: string): void {
    if (attention().has(group)) return;
    setAttention(new Set([...attention(), group]));
  }

  /** A new pass-1 run: empty store and log at this frame rate. */
  function reset(o: { fps: number; live: boolean; frameCount?: number }): void {
    fps = o.fps > 0 ? o.fps : 20;
    live = o.live;
    wall0 = clock();
    processedS = 0;
    lastDropped = 0;
    gapPending = 0;
    lastGapT = -Infinity;
    history = new StreamHistory();
    events = new RunEvents();
    for (const s of allSeries()) history.define(s);
    history.onRangeStep = (key, e) => {
      const spec = history.spec(key);
      const fmt = (r: [number, number]) => (r[0] === -r[1] ? `±${r[1]}` : `${r[0]}–${r[1]}`);
      events.push({
        frame: Math.round(e.t * fps),
        t: e.t,
        kind: 'range',
        key,
        from: fmt(e.from),
        to: fmt(e.to),
        detail:
          `${spec?.short ?? key} range ${fmt(e.from)} → ${fmt(e.to)} ${spec?.unit ?? ''}`.trim(),
        replay: false,
        wall: clock(),
      });
      if (spec) flag(spec.group);
    };
    setAttention(new Set<string>());
    const n = o.frameCount;
    setRunEnd(n !== undefined && Number.isFinite(n) && n > 0 ? n / fps : null);
    events.push({ frame: 0, t: 0, kind: 'pass', to: 1, detail: 'Pass 1 started', wall: wall0 });
    bump();
  }

  /** Log an event at stream frame `frame` (the time and wall clock are filled in). */
  function log(e: Omit<RunEvent, 't' | 'wall'> & { t?: number }): void {
    events.push({ ...e, t: e.t ?? e.frame / fps, wall: clock() });
    if (e.kind === 'warning' || e.kind === 'gap' || e.kind === 'error') flag('throughput');
    bump();
  }

  /** One processed batch: per-frame motion and flicker, imaging summaries, the wall clock. */
  function batch(b: HistoryBatch, rate: number, fastMs: number, lagFrames: number | null): void {
    const f = b.flags;
    const flagged = new Float32Array(b.count);
    for (let i = 0; i < b.count; i++) flagged[i] = f[i] & FLAGGED ? 100 : 0;
    history.pushFrames('shift_dy', b.start, b.dy, fps);
    history.pushFrames('shift_dx', b.start, b.dx, fps);
    history.pushFrames('motion_quality', b.start, b.quality, fps);
    history.pushFrames('motion_flagged', b.start, flagged, fps);
    history.pushFrames('flicker_offset', b.start, b.flickerOffset, fps);
    history.pushFrames('flicker_gain', b.start, b.flickerGain, fps, 100);
    const end = b.start + b.count;
    const t = (end - 1) / fps;
    if (b.imaging) {
      const ti = b.imaging.frame / fps;
      history.push('noise_sigma', ti, b.imaging.noiseSigma);
      history.push('background', ti, b.imaging.background);
    }
    if (rate > 0) history.push('proc_fps', t, rate);
    history.push('fast_ms', t, fastMs);
    if (lagFrames !== null) history.push('slow_lag', t, lagFrames / fps);
    history.push('wall_s', t, (clock() - wall0) / 1000);
    processedS = end / fps;
    history.advance(processedS);
    bump();
  }

  /** The live source's counters after a batch. */
  function liveCounters(p: {
    frame: number;
    dropped: number;
    missed: number;
    lagMs: number;
  }): void {
    const t = Math.max(0, p.frame - 1) / fps;
    const lost = p.dropped + p.missed;
    if (lost > lastDropped) {
      const n = lost - lastDropped;
      history.push('live_dropped', t, n);
      gapPending += n;
    }
    lastDropped = lost;
    // One gap event per 10 s of stream at most: the rate series has the detail.
    if (gapPending > 0 && t - lastGapT >= 10) {
      log({
        frame: p.frame,
        kind: 'gap',
        detail: `${gapPending.toLocaleString()} frames dropped or missed`,
      });
      gapPending = 0;
      lastGapT = t;
    }
    history.push('live_lag', t, p.lagMs / 1000);
  }

  /** A QC snapshot at stream frame `frame`. */
  function convergence(frame: number, s: ConvergenceSample, working: number | null): void {
    const t = frame / fps;
    const e = s.edits;
    history.push('cells', t, s.cells);
    history.push('explained', t, s.explained);
    history.push('residual_excess', t, s.residualExcess);
    history.push('stable', t, s.stableFrac);
    history.push('fp_cosine', t, s.fpStability);
    history.push('snr_median', t, s.snrMedian);
    history.push('pass_frac', t, s.passFrac);
    history.push('new_per_min', t, e.newAdds);
    history.push('churn_per_min', t, e.reAdds + e.churned + e.establishedRemovals);
    history.push('churn_readds', t, e.reAdds);
    history.push('churn_removed_again', t, e.churned);
    history.push('churn_established', t, e.establishedRemovals);
    if (working !== null) history.push('working_set', t, working);
  }

  /** A new flat-field map came out of the estimator (`change`: relative, 0..1). */
  function flatMap(change: number): void {
    if (Number.isFinite(change)) history.push('flat_change', processedS, 100 * change);
  }

  return {
    reset,
    batch,
    liveCounters,
    convergence,
    flatMap,
    log,
    /** Changes whenever the store or the log changed. */
    tick,
    history: () => history,
    events: () => events,
    fps: () => fps,
    live: () => live,
    /** Stream seconds processed (the "now" line). */
    now: () => processedS,
    /** A recording's length in stream seconds (null: live, it grows). */
    runEnd,
    /** Wall clock ms at stream time `t` (null before data). */
    clockAt(t: number): number | null {
      const b = history.at('wall_s', t);
      return b && Number.isFinite(b.last) ? wall0 + b.last * 1000 : null;
    },
    /** Groups with something new to look at (a range stepped, a warning). */
    attention,
    seen(group: string): void {
      if (!attention().has(group)) return;
      const next = new Set(attention());
      next.delete(group);
      setAttention(next);
    },
  };
}

export type RunHistory = ReturnType<typeof createRunHistory>;
