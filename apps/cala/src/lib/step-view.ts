/**
 * The three main steps of a run as the stepper and the step panels show them: Discover, Final
 * settle, Extract (docs/stages.md). Pure: numbers in, words and fractions out, so the stepper and
 * the panels agree and are tested without a DOM. Look-back and Background settle run inside
 * Discover and are its sub-line, not steps of their own.
 */

export type StepKey = 'discover' | 'settle' | 'extract';

/** waiting: not started; off: will not run (look-back off, Extract unticked, a live stream). */
export type StepState = 'waiting' | 'running' | 'paused' | 'done' | 'off' | 'error';

export interface StepView {
  key: StepKey;
  label: string;
  state: StepState;
  /** 0..1, or null when there is no end (a live stream) or nothing to show. */
  fraction: number | null;
  /** Frames per second while it runs (null otherwise or unknown). */
  fps: number | null;
  /** Seconds left at the current rate (null when unknown or not running). */
  secondsLeft: number | null;
  /** A short sub-line (e.g. look-back inside Discover, why a step is off). */
  note: string;
}

export const STEP_LABEL: Record<StepKey, string> = {
  discover: 'Discover',
  settle: 'Final settle',
  extract: 'Extract',
};

export interface StepInput {
  live: boolean;
  /** The pipeline: idle, starting, running, paused, done, error. */
  discover: string;
  /** Frames read and the recording's frames (Infinity for a live stream). */
  processed: number;
  total: number;
  discoverFps: number;
  /** Look-back is set (for the next start) and runs in this run. */
  lookback: boolean;
  lookbackRun: boolean;
  /** The Final settle is running now, and its frames fed of planned (0 before it starts). */
  settling: boolean;
  settleFed: number;
  settleTotal: number;
  settleFps: number;
  /** The final library is out (after the Final settle, or right after Discover without it). */
  finalLibrary: boolean;
  /** Look-back sub-line: cells still waiting for look-back data (null: none). */
  inNeed: number | null;
  /** Extract: idle, running, done, error, cancelled; frames solved of its total; rate. */
  extract: string;
  extractDone: number;
  extractTotal: number;
  extractFps: number;
  /** Extract follows Discover by itself (the setting, or always in a session run). */
  autoExtract: boolean;
  /** A `?factors` stream: its Final settle and Extract run on the stream's own factors. */
  factorRun?: boolean;
}

const left = (framesLeft: number, fps: number): number | null =>
  fps > 0 && Number.isFinite(framesLeft) && framesLeft >= 0 ? framesLeft / fps : null;

const frac = (a: number, b: number): number | null =>
  b > 0 && Number.isFinite(b) ? Math.min(1, Math.max(0, a / b)) : null;

/** The three steps now. */
export function stepViews(i: StepInput): StepView[] {
  const busy = i.discover === 'running' || i.discover === 'paused' || i.discover === 'starting';
  const dState: StepState =
    i.discover === 'error'
      ? 'error'
      : i.discover === 'done'
        ? 'done'
        : i.discover === 'paused'
          ? 'paused'
          : busy
            ? 'running'
            : 'waiting';
  const dRun = dState === 'running';
  const discover: StepView = {
    key: 'discover',
    label: STEP_LABEL.discover,
    state: dState,
    fraction: i.live ? null : dState === 'done' ? 1 : frac(i.processed, i.total),
    fps: dRun && i.discoverFps > 0 ? i.discoverFps : null,
    secondsLeft: dRun && !i.live ? left(i.total - i.processed, i.discoverFps) : null,
    note: i.live
      ? 'live stream'
      : i.lookbackRun && busy
        ? `with look-back${i.inNeed !== null && i.inNeed > 0 ? ` (${i.inNeed.toLocaleString('en-US')} cells waiting)` : ''} and Background settle`
        : '',
  };

  const settleOn =
    i.factorRun === true ||
    (!i.live && (busy || i.discover === 'done' ? i.lookbackRun : i.lookback));
  let sState: StepState;
  if (!settleOn) sState = 'off';
  else if (i.settling) sState = 'running';
  else if (i.discover === 'done' && i.finalLibrary) sState = 'done';
  else sState = 'waiting';
  const settle: StepView = {
    key: 'settle',
    label: STEP_LABEL.settle,
    state: sState,
    fraction:
      sState === 'done' ? 1 : sState === 'off' ? null : (frac(i.settleFed, i.settleTotal) ?? 0),
    fps: sState === 'running' && i.settleFps > 0 ? i.settleFps : null,
    secondsLeft: sState === 'running' ? left(i.settleTotal - i.settleFed, i.settleFps) : null,
    note: settleOn ? '' : i.live ? 'not for a live stream' : 'look-back off',
  };

  let eState: StepState;
  if (i.live && !i.factorRun) eState = 'off';
  else if (i.extract === 'running') eState = 'running';
  else if (i.extract === 'done') eState = 'done';
  else if (i.extract === 'error' || i.extract === 'cancelled') eState = 'error';
  else eState = i.autoExtract ? 'waiting' : 'off';
  const extract: StepView = {
    key: 'extract',
    label: STEP_LABEL.extract,
    state: eState,
    fraction:
      eState === 'done' ? 1 : eState === 'off' ? null : (frac(i.extractDone, i.extractTotal) ?? 0),
    fps: eState === 'running' && i.extractFps > 0 ? i.extractFps : null,
    secondsLeft: eState === 'running' ? left(i.extractTotal - i.extractDone, i.extractFps) : null,
    note:
      i.live && !i.factorRun
        ? 'not for a live stream'
        : eState === 'off'
          ? 'run it from Results'
          : i.extract === 'cancelled'
            ? 'cancelled'
            : '',
  };
  return [discover, settle, extract];
}

/** "45 % · 180 frames/s · 1 min 10 s left" for a step's header ('' parts left out). */
export function stepNumbers(v: StepView, fmtDuration: (s: number) => string): string {
  const parts: string[] = [];
  if (v.fraction !== null && v.state !== 'off') parts.push(`${Math.floor(100 * v.fraction)} %`);
  if (v.fps !== null) parts.push(`${Math.round(v.fps).toLocaleString('en-US')} frames/s`);
  if (v.secondsLeft !== null) parts.push(`${fmtDuration(v.secondsLeft)} left`);
  return parts.join(' · ');
}

export const STATE_WORD: Record<StepState, string> = {
  waiting: 'waiting',
  running: 'running',
  paused: 'paused',
  done: 'done',
  off: 'off',
  error: 'stopped',
};
