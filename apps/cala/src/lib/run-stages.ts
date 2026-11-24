/**
 * Named run stages (docs/stages.md): Discover, Extract.
 *
 * - Discover finds cells and builds footprints with live traces (a file or a
 *   live stream). For a recording it runs with look-back, which re-reads
 *   earlier frames for each new cell, and ends with the Final settle, which
 *   lets the footprints converge with the cell set frozen. (There used to be
 *   a separate Refine stage that replayed the recording for that; look-back
 *   and the Final settle replaced it. Saved results from before still list
 *   `refine` runs, hence `RecordedStageName`.)
 * - Extract (recordings only) solves the final traces of every frame with the
 *   footprints frozen.
 *
 * This module is the pure part: which stage may run now and the log of the
 * runs (for the panel and the export). The stores (`pipeline-store`,
 * `pass2-store`) run the stages.
 */
import { createSignal } from 'solid-js';
import type { FactorInfo } from './compress-store.ts';

export type StageName = 'discover' | 'extract';

/** A stage name as a saved result may hold it: `refine` runs exist only in results from builds before Refine was removed. */
export type RecordedStageName = StageName | 'refine';

/** The names as the UI, the export and the logs spell them. */
export const STAGE_LABEL: Record<RecordedStageName, string> = {
  discover: 'Discover',
  refine: 'Refine (removed stage)',
  extract: 'Extract',
};

/**
 * Where a run's starting library comes from. Only `discover` (an empty
 * library) exists; a library from a file (a past session) is deferred until
 * cross-session alignment (lateral registration for 1p) exists, and would be
 * a second variant here.
 */
export type LibrarySource = { kind: 'discover' };

/** The state of one stage's store, as far as availability is concerned. */
export type StageActivity = 'idle' | 'running' | 'done' | 'error' | 'cancelled';

export interface StageInput {
  /** A live stream: Discover only. */
  live: boolean;
  /** Discover (the pipeline): idle, running (incl. starting, paused), done or error. */
  discover: StageActivity;
  extract: StageActivity;
  /** The slow loop's final library is out (after Discover and its Final settle). */
  finalLibrary: boolean;
  /** Cells in the newest library. */
  cells: number;
  /** Why the recorded motion and flicker cannot be replayed (null: they can). */
  replayBlocked: string | null;
  /** A `?factors` stream: Extract solves on the stream's factors. */
  liveFactors?: boolean;
}

export const LIVE_NOTE =
  'A live stream runs Discover only: there is no file to replay. Save the stream and load it as a recording later to Extract.';

/**
 * "Extract after Discover" default for recordings: on. With Refine gone,
 * Discover (with look-back and its Final settle) hands over settled
 * footprints, so Extract follows it directly. Nothing persists the option,
 * so there is no saved value to respect.
 */
export const EXTRACT_AFTER_DISCOVER_DEFAULT = true;

/**
 * The "Extract after Discover" setting, shared by the Run tab (which sets it and acts on it) and
 * the step stepper above the tabs (which shows Extract as off when it is unticked).
 */
export const [extractAfterDiscover, setExtractAfterDiscover] = createSignal(
  EXTRACT_AFTER_DISCOVER_DEFAULT,
);

export const NEXT_STEP_HINT = 'Extract to solve the final traces with the settled footprints.';

/** Show the next-step hint: a recording whose Discover is done, before any Extract. */
export function showNextStepHint(i: {
  live: boolean;
  discover: StageActivity;
  extract: StageActivity;
}): boolean {
  return !i.live && i.discover === 'done' && i.extract === 'idle';
}

/** Why each stage cannot start now (null: it can). */
export function stageAvailability(i: StageInput): Record<StageName, string | null> {
  const busy =
    i.discover === 'running'
      ? 'Discover is running.'
      : i.extract === 'running'
        ? 'Extract is running.'
        : null;
  const after = (stage: string): string | null => {
    if (i.live && !i.liveFactors) return LIVE_NOTE;
    if (busy) return busy;
    if (i.discover !== 'done') return `${stage} runs after Discover finishes.`;
    if (i.replayBlocked) return i.replayBlocked;
    if (!i.finalLibrary) return 'Waiting for the final library.';
    if (i.cells === 0) return 'No cells were found.';
    return null;
  };
  return {
    // A new Discover run is always possible (it starts over); never during a replay.
    discover: i.extract === 'running' ? busy : null,
    extract: after('Extract'),
  };
}

/** What one run of a stage did (the panel's readout, the export's `stages`). */
export interface StageRun {
  /** `refine` only in a saved result from before Refine was removed. */
  stage: RecordedStageName;
  /** 1-based count of this stage's runs since Discover started. */
  index: number;
  /** ISO timestamps. */
  startedAt: string;
  endedAt: string | null;
  outcome: 'running' | 'done' | 'cancelled' | 'error';
  /** Frames the run went through. */
  frames: number;
  /** Cells and library version at its end. */
  cells: number;
  libraryVersion: number;
  /** Discover: refinements the slow loop made during the run, and per minute of recording. */
  refines?: number;
  refinesPerMin?: number | null;
  /** Discover: cells added, merged, deleted and split during the run. */
  adds?: number;
  merges?: number;
  deletes?: number;
  splits?: number;
  /** Discover: it ran with look-back (and its settle). */
  lookback?: boolean;
  /** Discover: the Final settle read the factors or, with `?factors=file`, the file, and why. */
  settleSource?: 'factors' | 'file';
  settleSourceReason?: string;
  /** Extract: it solved the frames rebuilt from the factors (and which), or replayed the file and why. */
  source?: 'factors' | 'file';
  sourceReason?: string;
  factors?: FactorInfo;
  /**
   * Discover of a factor run: compress workers while it read and after its end,
   * the frames not compressed at its end, the waiting window files' peak, and
   * the pace after its end (frames/s).
   */
  compress?: {
    workers: number;
    workersAfter: number;
    behindFrames: number | null;
    backlogPeakBytes: number;
    fpsAfter: number | null;
  };
}

/** Runs of the stages since the last Discover start, in order. */
export function createStageLog(now: () => Date = () => new Date()) {
  const [runs, setRuns] = createSignal<StageRun[]>([]);

  function begin(stage: StageName): void {
    const list = runs();
    const index = list.filter((r) => r.stage === stage).length + 1;
    setRuns([
      ...list,
      {
        stage,
        index,
        startedAt: now().toISOString(),
        endedAt: null,
        outcome: 'running',
        frames: 0,
        cells: 0,
        libraryVersion: 0,
      },
    ]);
  }

  /** End the newest run of `stage` (no-op when none is running). */
  function end(
    stage: StageName,
    outcome: Exclude<StageRun['outcome'], 'running'>,
    data: Partial<Omit<StageRun, 'stage' | 'index' | 'startedAt' | 'endedAt' | 'outcome'>>,
  ): void {
    const list = runs();
    const k = list.findLastIndex((r) => r.stage === stage && r.outcome === 'running');
    if (k < 0) return;
    const next = list.slice();
    next[k] = { ...list[k], ...data, outcome, endedAt: now().toISOString() };
    setRuns(next);
  }

  return {
    runs,
    begin,
    end,
    /** The newest run of `stage`, if any. */
    last: (stage: StageName): StageRun | undefined => runs().findLast((r) => r.stage === stage),
    /** A new Discover run starts over. */
    reset(): void {
      setRuns([]);
    },
  };
}

export type StageLog = ReturnType<typeof createStageLog>;

/** Refinements per minute of recording (null when the frame rate or the frames are unknown). */
export function perMinute(count: number, frames: number, fps: number): number | null {
  if (!(fps > 0) || !(frames > 0)) return null;
  return count / (frames / fps / 60);
}
