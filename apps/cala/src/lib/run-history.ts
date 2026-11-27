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
import { StreamHistory, type HistoryExport, type SeriesSpec } from '@calab/compute';
import { OKABE_ITO } from '@calab/ui/palette';
import { RunEvents, type RunEvent } from './run-events.ts';
import {
  KIND_COLOR,
  WORK_KIND_LABELS,
  WORK_KINDS,
  workByKind,
  type WorkKind,
  type WorkRates,
} from './work-meter.ts';

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
      color: OKABE_ITO.blue,
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
      color: OKABE_ITO.bluishGreen,
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
      color: OKABE_ITO.orange,
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
      color: OKABE_ITO.reddishPurple,
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
      color: OKABE_ITO.skyBlue,
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
      color: OKABE_ITO.vermillion,
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
      color: OKABE_ITO.blue,
      digits: 2,
      hint: 'Per-pixel noise σ (MAD of frame-to-frame differences, the SNR convention), median over the FOV.',
    },
    {
      key: 'background',
      label: 'Background (median over the FOV)',
      short: 'Background',
      unit: 'grey',
      kind: 'value',
      // The floor is estimated after flattening, so it sits near zero and can go below it.
      range: [-50, 50],
      rangeRule: 'ladder125',
      color: OKABE_ITO.orange,
      digits: 1,
      hint: 'Background floor removed by preprocessing (after flattening), median over the FOV.',
    },
    {
      key: 'flicker_gain',
      label: 'Flicker gain m',
      short: 'Gain',
      unit: '%',
      kind: 'value',
      range: [-5, 5],
      rangeRule: 'ladder125',
      color: OKABE_ITO.bluishGreen,
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
      color: OKABE_ITO.reddishPurple,
      digits: 2,
      hint: 'Global sensor offset removed per frame, relative to the last ~second.',
    },
    {
      key: 'flat_change',
      label: 'Flat-field update (median change)',
      short: 'Flat field',
      unit: 'σ',
      kind: 'stem',
      range: [0, 2],
      rangeRule: 'ladder125',
      color: OKABE_ITO.black,
      digits: 2,
      hint: 'How much the sensor flat field moved at each new map: the median change in units of its own uncertainty.',
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
      color: OKABE_ITO.blue,
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
      color: OKABE_ITO.vermillion,
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
      color: OKABE_ITO.orange,
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
      color: OKABE_ITO.bluishGreen,
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
      color: OKABE_ITO.blue,
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
      color: OKABE_ITO.orange,
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
      color: OKABE_ITO.vermillion,
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
      color: OKABE_ITO.skyBlue,
      digits: 2,
      hint: 'How far processing is behind the live stream, seconds.',
    },
  ],
};

/** The work-share series: fixed 0-1 ranges (a share is a share), the fast loop's top speed on a ladder. */
const WORK_SERIES: SeriesSpec[] = [
  ...(
    [
      ['work_live', 'Slow worker: live batches', OKABE_ITO.blue],
      ['work_visit', 'Slow worker: visit hand-out and apply', OKABE_ITO.bluishGreen],
      ['work_need', 'Slow worker: need-driven look-back answers', OKABE_ITO.orange],
      ['work_settle', 'Slow worker: settle answers and end settle', OKABE_ITO.reddishPurple],
      ['work_publish', 'Slow worker: publishing', OKABE_ITO.skyBlue],
      ['work_other', 'Slow worker: housekeeping, set-up and replay', OKABE_ITO.vermillion],
      ['work_idle', 'Slow worker: idle', OKABE_ITO.black],
      ['work_visit_busy', 'Visit workers: mean busy share', OKABE_ITO.bluishGreen],
      ['work_lookback_busy', 'Look-back worker: busy share', OKABE_ITO.orange],
    ] as const
  ).map(([key, label, color]): SeriesSpec => ({
    key,
    label,
    unit: '',
    group: 'extra',
    kind: 'value',
    range: [0, 1],
    rangeRule: 'fixed',
    color,
    digits: 2,
  })),
  {
    key: 'fast_max_fps',
    label: 'Fast loop top speed (estimate)',
    unit: 'fps',
    group: 'extra',
    kind: 'value',
    range: [0, 120],
    rangeRule: 'ladder125',
    color: OKABE_ITO.blue,
    digits: 0,
  },
];

/** The work-by-kind series (`workByKind` totals, worker-seconds per second), in the display's names and colours. */
const KIND_SERIES: [WorkKind, string, string][] = WORK_KINDS.map((k) => [
  k,
  WORK_KIND_LABELS[k],
  KIND_COLOR[k],
]);

/** The history key of a kind's series. */
export const kindSeriesKey = (k: WorkKind): string =>
  `kind_${k === 'bgSettle' ? 'bg_settle' : k === 'finalSettle' ? 'final_settle' : k}`;

/**
 * The series of work by kind (fixed range 0 to the number of workers the app started), the speed
 * target (the slider's scale, Max stored as 0) and births per 1,000 frames.
 */
function displaySeries(workers: number): SeriesSpec[] {
  return [
    ...KIND_SERIES.map(([kind, name, color]): SeriesSpec => ({
      key: kindSeriesKey(kind),
      label: `Work: ${name}`,
      unit: 'workers',
      group: 'extra',
      kind: 'value',
      range: [0, Math.max(1, workers)],
      rangeRule: 'fixed',
      color,
      digits: 2,
      hint: 'Worker-seconds of work per second of wall time.',
    })),
    {
      key: 'target_fps',
      label: 'Speed target',
      unit: 'fps',
      group: 'extra',
      kind: 'value',
      range: [10, 500],
      rangeRule: 'fixed',
      color: OKABE_ITO.blue,
      dash: [4, 3],
      digits: 0,
      hint: 'The speed the run is paced to; 0 is Max (no pacing).',
    },
    {
      key: 'births_per_kframe',
      label: 'Cells born per 1,000 frames',
      unit: '/1000 frames',
      group: 'extra',
      kind: 'value',
      range: [0, 50],
      // Fixed: the opening burst of a run clips instead of stepping the range and flagging History.
      rangeRule: 'fixed',
      color: OKABE_ITO.bluishGreen,
      digits: 1,
      hint: 'Cells added by the slow loop per 1,000 frames of stream (last 2,000 frames).',
    },
  ];
}

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
    color: OKABE_ITO.bluishGreen,
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
    color: OKABE_ITO.orange,
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
    color: OKABE_ITO.reddishPurple,
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
    color: OKABE_ITO.blue,
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
    color: OKABE_ITO.blue,
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
    color: OKABE_ITO.blue,
    digits: 1,
  },
  // Who is doing what (`lib/work-meter.ts`): the slow worker's shares of wall time by duty, the
  // busy shares of the visit workers (mean) and the look-back worker, and the fast loop's top speed.
  ...WORK_SERIES,
  {
    key: 'wall_s',
    label: 'Wall clock since the run started',
    unit: 's',
    group: 'extra',
    kind: 'value',
    range: [0, 1],
    rangeRule: 'double',
    color: OKABE_ITO.black,
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
export function allSeries(workers: number): SeriesSpec[] {
  return [
    ...HISTORY_GROUPS.flatMap((g) => SERIES[g.id].map((s) => ({ ...s, group: g.id }))),
    ...EXTRA,
    ...displaySeries(workers),
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

/** The `setting` events of the speed control. */
export type SpeedSettingKey = 'target_speed' | 'speed_floor' | 'speed_auto' | 'settle_cap';

const SPEED_SETTING_LABEL: Record<SpeedSettingKey, string> = {
  target_speed: 'Speed target',
  speed_floor: 'Speed floor',
  speed_auto: 'Auto speed',
  settle_cap: 'Settle cap',
};

/** A speed as the log words it: a number is fps, 0 is Max; a word is left as it is. */
const speedText = (v: number | string): string =>
  typeof v === 'number' ? (v > 0 ? `${v} fps` : 'Max') : v;

/** An empty store with every series registered. */
function freshStore(workers: number): StreamHistory {
  const h = new StreamHistory();
  for (const s of allSeries(workers)) h.define(s);
  return h;
}

export function createRunHistory(clock: () => number = () => Date.now()) {
  let history = freshStore(1);
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
    setAttention((cur) => (cur.has(group) ? cur : new Set([...cur, group])));
  }

  /** A new pass-1 run: empty store and log at this frame rate. */
  function reset(o: { fps: number; live: boolean; frameCount?: number; workers: number }): void {
    fps = o.fps > 0 ? o.fps : 20;
    live = o.live;
    wall0 = clock();
    processedS = 0;
    lastDropped = 0;
    gapPending = 0;
    lastGapT = -Infinity;
    history = freshStore(o.workers);
    events = new RunEvents();
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
    events.push({
      frame: 0,
      t: 0,
      kind: 'stage',
      to: 'discover',
      detail: 'Discover started',
      wall: wall0,
    });
    bump();
  }

  /**
   * Show a saved run (read-only viewer): its history bins and event log as
   * exported (`StreamHistory.toExport`, `RunEvents.toJSON`), or an empty
   * history when the export has none.
   */
  function load(o: { bins: HistoryExport | null; events: readonly RunEvent[]; fps: number }): void {
    fps = o.fps > 0 ? o.fps : 20;
    live = false;
    lastDropped = 0;
    gapPending = 0;
    lastGapT = -Infinity;
    history = o.bins ? StreamHistory.fromExport(o.bins, allSeries(1)) : freshStore(1);
    // (A saved run keeps the ranges it was exported with; the 1 only fills series an old export lacks.)
    events = new RunEvents();
    for (const e of o.events) events.push(e);
    wall0 = o.events.find((e) => typeof e.wall === 'number')?.wall ?? clock();
    processedS = history.end();
    setAttention(new Set<string>());
    setRunEnd(processedS > 0 ? processedS : null);
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

  /**
   * The work shares of the last second or so (`WorkRates`) and the fast loop's top-speed estimate.
   * Pushed at the stream time Discover has reached, so the caller stops after its last frame (the
   * final settle's accounting lives in the `?debug` readout and the `-work.json` log only: stream
   * time stands still then and every sample would land in one bin).
   */
  function work(r: WorkRates, maxFps: number): void {
    const t = processedS;
    const s = r.slow;
    history.push('work_live', t, s.live);
    history.push('work_visit', t, s.visit);
    history.push('work_need', t, s.need);
    history.push('work_settle', t, s.csettle + s.end);
    history.push('work_publish', t, s.publish);
    history.push('work_other', t, s.housekeep + s.setup);
    history.push('work_idle', t, s.idle);
    if (r.visit.length > 0)
      history.push('work_visit_busy', t, r.visit.reduce((a, b) => a + b, 0) / r.visit.length);
    // The share of one worker's time: the sum over a pool can exceed 1, so divide by the workers.
    history.push(
      'work_lookback_busy',
      t,
      r.lookback.busy / Math.max(1, r.lookback.capacity ?? r.lookback.workers.length),
    );
    if (maxFps > 0) history.push('fast_max_fps', t, maxFps);
    const { totals: byKind, count } = workByKind(r);
    // The pool can grow mid-run: widen the (fixed) range before a value needs it.
    for (const k of WORK_KINDS) history.widenFixedRange(kindSeriesKey(k), count);
    for (const k of WORK_KINDS) history.push(kindSeriesKey(k), t, byKind[k]);
  }

  /** The speed target now, fps (0 = Max), at the stream time Discover has reached. */
  function target(fpsTarget: number): void {
    history.push('target_fps', processedS, fpsTarget > 0 ? fpsTarget : 0);
  }

  /** Cells born per 1,000 frames at stream frame `frame` (from `BirthRate`). */
  function births(frame: number, perKFrames: number): void {
    if (Number.isFinite(perKFrames)) history.push('births_per_kframe', frame / fps, perKFrames);
  }

  /**
   * A change of the speed control at stream frame `frame`, as a `setting` event
   * (`target_speed`, `speed_floor`, `speed_auto`); 0 as a speed is Max.
   */
  function speedSetting(
    key: SpeedSettingKey,
    frame: number,
    from: number | string,
    to: number | string,
    detail?: string,
    /** Who set it, when not the user (`curve`, `auto`): named in the text and kept as `data.source`. */
    source?: string,
  ): void {
    const by = source === 'curve' || source === 'auto' ? ` (${source})` : '';
    log({
      frame,
      kind: 'setting',
      key,
      from,
      to,
      detail: detail ?? `${SPEED_SETTING_LABEL[key]} ${speedText(from)} → ${speedText(to)}${by}`,
      replay: false,
      ...(by ? { data: { source: source as string } } : {}),
    });
  }

  /** A new flat-field map came out of the estimator (`change`: median change, σ). */
  function flatMap(change: number): void {
    if (Number.isFinite(change)) history.push('flat_change', processedS, change);
  }

  return {
    reset,
    load,
    batch,
    liveCounters,
    convergence,
    work,
    target,
    births,
    speedSetting,
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
