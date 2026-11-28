/**
 * The run rail's view: the stage track (Discover, Final settle, Extract), the line under it,
 * and the live figures (Cells, Speed, Workers, Refinement, Memory), each on a declared range.
 * Pure: numbers in, segments, words and figures out, so it is tested without a DOM. Stage
 * states come from `stepViews` (`lib/step-view.ts`), the same view as the Run tab's step
 * panels, so the rail and the panels always agree.
 */
import type { StageSegment, StageState } from '@calab/ui';
import { STEP_LABEL, type StepKey, type StepView } from './step-view.ts';

/**
 * Expected cost of one frame of each stage, in Discover frames at Max. They size the track's
 * segments and turn the current stage's rate into a whole-run time left; they never change a
 * result. Final settle reads each frame again with look-back visits; Extract only solves
 * traces against frozen footprints, usually on the compressed factors.
 */
export const STAGE_FRAME_COST: Record<StepKey, number> = {
  discover: 1,
  settle: 1,
  extract: 0.1,
};

/** Smallest share of the track a stage that runs gets, so its label fits; one that is off gets less. */
export const MIN_SHARE = { on: 0.24, off: 0.14 } as const;

/** Share of the Discover segment drawn as the setup lead-in (calibration, motion template). */
export const LEAD_IN_SHARE = 0.1;

/** The Speed figure's declared range, fps (log); the Speed block's track uses the same. */
export const RAIL_SPEED_RANGE = { min: 10, max: 500 } as const;

/** The Refinement gauge's declared range, visits per frame. */
export const RAIL_VISIT_RANGE = { min: 0, max: 0.5 } as const;

/** The visit rate's allowed band around its target, as factors of the target (`lib/visit-rate.ts`). */
export const VISIT_BAND = [2 / 3, 4 / 3] as const;

/**
 * The Memory meter's declared range, bytes: 0 to 4 GiB. One WASM instance can address at most
 * 4 GiB; the figure sums several instances, so a value past the end is drawn clamped.
 */
export const RAIL_MEMORY_MAX = 4 * 1024 ** 3;

/** Setup before Discover's first frame (`PipelineStore.setup`). */
export interface RailSetup {
  phase: 'calibrate' | 'motion-warmup';
  done: number;
  total: number;
}

const SETUP_WORD: Record<RailSetup['phase'], string> = {
  calibrate: 'Calibrating',
  'motion-warmup': 'Motion template',
};

export interface RailTrackInput {
  /** The three steps now (`stepViews`). */
  steps: StepView[];
  live: boolean;
  /** Recording frames (Infinity for a live stream) and the Final settle's planned frames. */
  total: number;
  settleFrames: number;
  /** Setup in progress (null: none, or Discover has read frames). */
  setup: RailSetup | null;
  /** Discover frames read; Final settle frames fed of its total; Extract frames solved of its total. */
  processed: number;
  settleFed: number;
  settleTotal: number;
  extractDone: number;
  extractTotal: number;
}

/** One stage on the rail: the segment, its share of the track, and its fill in [0, 1]. */
export interface RailStage {
  segment: StageSegment;
  share: number;
}

const HUE: Record<StepKey, 'discover' | 'settle' | 'extract'> = {
  discover: 'discover',
  settle: 'settle',
  extract: 'extract',
};

const isOn = (v: StepView): boolean => v.state !== 'off';

/**
 * Shares of the track: each stage's expected duration (frames x `STAGE_FRAME_COST`), at least
 * `MIN_SHARE`, summing to 1. They depend only on the recording's length, the planned settle and
 * which stages run, so they hold still for the whole run.
 */
export function stageShares(
  total: number,
  settleFrames: number,
  on: Record<StepKey, boolean>,
): Record<StepKey, number> {
  const frames: Record<StepKey, number> = {
    discover: Number.isFinite(total) ? total : 1,
    settle: Number.isFinite(settleFrames) ? settleFrames : 0,
    extract: Number.isFinite(total) ? total : 0,
  };
  const keys: StepKey[] = ['discover', 'settle', 'extract'];
  const raw = keys.map((k) => (on[k] ? Math.max(0, frames[k] * STAGE_FRAME_COST[k]) : 0));
  const sum = raw.reduce((a, b) => a + b, 0) || 1;
  const floor = keys.map((k) => (on[k] ? MIN_SHARE.on : MIN_SHARE.off));
  // Stages under their floor take the floor; the rest share what is left by duration.
  const fixed = new Set<number>();
  for (let pass = 0; pass < keys.length; pass++) {
    const left = 1 - [...fixed].reduce((a, i) => a + floor[i], 0);
    const freeSum = raw.reduce((a, r, i) => (fixed.has(i) ? a : a + r), 0);
    let changed = false;
    for (let i = 0; i < keys.length; i++) {
      if (fixed.has(i)) continue;
      const share = freeSum > 0 ? (left * raw[i]) / freeSum : 0;
      if (share < floor[i]) {
        fixed.add(i);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const left = 1 - [...fixed].reduce((a, i) => a + floor[i], 0);
  const freeSum = raw.reduce((a, r, i) => (fixed.has(i) ? a : a + r), 0);
  const out = {} as Record<StepKey, number>;
  keys.forEach((k, i) => {
    out[k] = fixed.has(i) ? floor[i] : freeSum > 0 ? (left * raw[i]) / freeSum : raw[i] / sum;
  });
  return out;
}

const n0 = (v: number): string => Math.round(v).toLocaleString('en-US');

/** "45 %" of a fraction (floored, so 100 % means done). */
const pctWord = (f: number): string => `${Math.floor(100 * f)} %`;

/** The rail's stage track. Paused shows as running with its fill held; the label says so. */
export function railStages(i: RailTrackInput): RailStage[] {
  const on = {
    discover: true,
    settle: isOn(i.steps[1]),
    extract: isOn(i.steps[2]),
  };
  const shares = stageShares(i.total, i.settleFrames, on);
  return i.steps.map((v) => {
    const state: StageState = v.state === 'paused' ? 'running' : v.state;
    let fraction: number | null = v.fraction;
    let leadIn: number | undefined;
    let title = `${v.label}: ${v.state === 'error' ? 'stopped' : v.state}`;
    let label = v.label;
    if (v.key === 'discover') {
      if (i.live) {
        fraction = null;
        label = `${v.label} · live`;
        title += ` · frame ${n0(i.processed)} (live stream, no end)`;
      } else {
        leadIn = LEAD_IN_SHARE;
        const own = v.fraction ?? 0;
        fraction =
          v.state === 'done'
            ? 1
            : i.setup && i.processed === 0
              ? LEAD_IN_SHARE * (i.setup.total > 0 ? i.setup.done / i.setup.total : 0)
              : LEAD_IN_SHARE + (1 - LEAD_IN_SHARE) * own;
        title += ` · ${n0(i.processed)} / ${n0(i.total)} frames (${pctWord(own)})`;
        if (i.setup && i.processed === 0)
          title += ` · ${SETUP_WORD[i.setup.phase]} ${n0(i.setup.done)} / ${n0(i.setup.total)}`;
      }
      if (v.state === 'paused') label = `${v.label} · paused`;
    } else if (v.key === 'settle' && v.state !== 'off') {
      title += ` · ${n0(i.settleFed)} / ${n0(i.settleTotal)} frames (${pctWord(v.fraction ?? 0)})`;
    } else if (v.key === 'extract' && v.state !== 'off') {
      title += ` · ${n0(i.extractDone)} / ${n0(i.extractTotal)} frames (${pctWord(v.fraction ?? 0)})`;
    }
    if (v.note) title += ` · ${v.note}`;
    return {
      share: shares[v.key],
      segment: {
        id: v.key,
        label,
        hue: HUE[v.key],
        weight: shares[v.key],
        state,
        fraction,
        ...(leadIn !== undefined ? { leadIn } : {}),
        title,
      },
    };
  });
}

/** Where the run is along the whole track, in [0, 1] (the segments' shares times their fills). */
export function trackPosition(stages: RailStage[]): number {
  let x = 0;
  for (const s of stages) {
    const st = s.segment.state;
    const f =
      st === 'done' ? 1 : st === 'running' ? Math.min(1, Math.max(0, s.segment.fraction ?? 0)) : 0;
    x += s.share * f;
  }
  return Math.min(1, x);
}

/** Seconds left in the whole run at the current stage's rate, or null when not known. */
export function runSecondsLeft(i: RailTrackInput): number | null {
  if (i.live) return null;
  const cur = i.steps.find((v) => v.state === 'running');
  if (!cur || cur.fps === null || !(cur.fps > 0)) return null;
  const rate = cur.fps * STAGE_FRAME_COST[cur.key];
  const leftFrames: Record<StepKey, number> = {
    discover: Math.max(0, i.total - i.processed),
    settle: Math.max(0, (i.settleTotal > 0 ? i.settleTotal : i.settleFrames) - i.settleFed),
    extract: Math.max(0, (i.extractTotal > 0 ? i.extractTotal : i.total) - i.extractDone),
  };
  let units = 0;
  for (const v of i.steps) {
    if (v.state === 'done' || v.state === 'off' || v.state === 'error') continue;
    const f = leftFrames[v.key];
    if (!Number.isFinite(f)) return null;
    units += f * STAGE_FRAME_COST[v.key];
  }
  return units / rate;
}

/** "about 1 min left" from seconds (rounded up to 5 s, then to minutes past 2 min). */
export function aboutLeft(sec: number): string {
  if (sec < 1) return 'under a second left';
  if (sec < 60) return `about ${Math.max(5, Math.ceil(sec / 5) * 5)} s left`;
  const m = Math.ceil(sec / 60);
  if (m < 60) return `about ${m} min left`;
  const h = Math.floor(m / 60);
  return `about ${h} h ${String(m % 60).padStart(2, '0')} min left`;
}

/** The one line under the track: where the current stage is, and the whole run's time left. */
export function railLabel(i: RailTrackInput & { discover: string }): string {
  const [d, s, e] = i.steps;
  if (i.discover === 'idle') return 'Ready';
  if (i.discover === 'starting') return 'Starting';
  if (d.state === 'error') return 'Stopped by an error';
  const left = runSecondsLeft(i);
  const tail = left !== null ? ` · ${aboutLeft(left)}` : '';
  const paused = d.state === 'paused' ? ' · paused' : '';
  if (d.state === 'running' || d.state === 'paused') {
    if (i.setup && i.processed === 0)
      return `${SETUP_WORD[i.setup.phase]} ${n0(i.setup.done)} / ${n0(i.setup.total)}${paused}`;
    if (i.live) return `frame ${n0(i.processed)} · live${paused}`;
    return `frame ${n0(i.processed)} / ${n0(i.total)}${paused || tail}`;
  }
  if (s.state === 'running') return `Final settle ${n0(i.settleFed)} / ${n0(i.settleTotal)}${tail}`;
  if (e.state === 'running')
    return `Extract frame ${n0(i.extractDone)} / ${n0(i.extractTotal)}${tail}`;
  const frames = i.live ? `frame ${n0(i.processed)}` : `frame ${n0(i.processed)} / ${n0(i.total)}`;
  if (e.state === 'done') return `${frames} · finished`;
  if (e.state === 'error') return `${frames} · Extract ${e.note || 'stopped'}`;
  return `${frames} · ${STEP_LABEL.discover} done`;
}

/**
 * The smallest 1, 2 or 5 x 10^k at or above `v` (at least `floor`): a figure's range end,
 * rounded up so it steps rarely.
 */
export function niceCeil(v: number, floor = 10): number {
  const x = Math.max(floor, Number.isFinite(v) ? v : 0);
  const p = 10 ** Math.floor(Math.log10(x));
  for (const m of [1, 2, 5, 10]) if (m * p >= x) return m * p;
  return 10 * p;
}

/**
 * What the rail keeps over a run: the cell count against the track position (the sparkline),
 * the Cells range end, and the workers' count N. Ranges only grow within a run; `reset` starts
 * a new run.
 */
export class RailHistory {
  /** Track positions in [0, 1] and cell counts, in order. */
  readonly x: number[] = [];
  readonly cells: number[] = [];
  /** The Cells range end: `niceCeil` of the most cells seen, never lower within a run. */
  cellsMax = niceCeil(0);
  /** Workers counted at most this run (the Workers meter's end), 0 before a reading. */
  workers = 0;

  reset(): void {
    this.x.length = 0;
    this.cells.length = 0;
    this.cellsMax = niceCeil(0);
    this.workers = 0;
  }

  /** Add a cell count at a track position; a position at or before the last replaces it. */
  addCells(x: number, n: number): void {
    if (!Number.isFinite(n)) return;
    const last = this.x.length - 1;
    if (last >= 0 && x <= this.x[last]) {
      this.cells[last] = n;
    } else {
      this.x.push(x);
      this.cells.push(n);
    }
    this.cellsMax = Math.max(this.cellsMax, niceCeil(n));
  }

  /** Note a workers count; N only grows within a run. */
  addWorkers(count: number): void {
    if (Number.isFinite(count) && count > this.workers) this.workers = count;
  }
}

/** Bytes as "1.4 GB" or "380 MB" (powers of 1024, like the browser's task manager). */
export function formatBytes(b: number): string {
  if (!(b > 0)) return '0 MB';
  const mb = b / 1024 ** 2;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

/** The rail's state for `data-state`: what the run is doing as a whole. */
export type RailState = 'idle' | 'running' | 'paused' | 'complete' | 'error';

/**
 * The stage now in words ("Discover", "Final settle", "Extract", "Discover done", "Extract
 * done", "Ready", "Stopped") and the rail's state: the rail's status text for assistive tech.
 */
export function railStatus(i: RailTrackInput & { discover: string }): {
  stage: string;
  state: RailState;
} {
  const [d, s, e] = i.steps;
  if (e.state === 'running') return { stage: STEP_LABEL.extract, state: 'running' };
  if (i.discover === 'starting') return { stage: 'Starting', state: 'running' };
  if (d.state === 'running' || d.state === 'paused') {
    const stage = i.setup && i.processed === 0 ? SETUP_WORD[i.setup.phase] : STEP_LABEL.discover;
    return { stage, state: d.state === 'paused' ? 'paused' : 'running' };
  }
  if (d.state === 'error') return { stage: 'Stopped', state: 'error' };
  if (i.discover === 'idle') return { stage: 'Ready', state: 'idle' };
  if (s.state === 'running') return { stage: STEP_LABEL.settle, state: 'running' };
  const last = e.state === 'done' ? STEP_LABEL.extract : STEP_LABEL.discover;
  return { stage: `${last} done`, state: 'complete' };
}

/** What, besides the 2 Hz beat, refreshes the rail at once (`createSampled`'s key). */
export interface RailKeyInput {
  discover: string;
  extract: string;
  settling: boolean;
  finalLibrary: boolean;
  setupPhase: string;
  /** No Discover frame read yet. */
  noFrames: boolean;
  /** The published library's version: a new cell count lands at once. */
  libraryVersion: number;
  /** A work reading and a visit-rate reading exist: the first of each lands at once. */
  hasWork: boolean;
  hasVisits: boolean;
}

/**
 * The rail's refresh key: changes of stage, a newly published library, and the first work and
 * visit readings of a run. Each changes a few times per run, so the figures stay at 2 Hz
 * between them, and a discrete fact never waits for the beat.
 */
export function railKey(i: RailKeyInput): string {
  return [
    i.discover,
    i.extract,
    i.settling,
    i.finalLibrary,
    i.setupPhase,
    i.noFrames,
    i.libraryVersion,
    i.hasWork,
    i.hasVisits,
  ].join('|');
}
