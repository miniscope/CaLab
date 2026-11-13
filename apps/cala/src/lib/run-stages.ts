/**
 * Named run stages (docs/stages.md): Discover, Refine, Extract.
 *
 * - Discover finds cells and builds footprints with live traces (a file or a
 *   live stream).
 * - Refine (recordings only, repeatable) replays the recording from frame 0
 *   into the same slow loop with the refine-only edit scope: footprints keep
 *   converging, the cell set is frozen.
 * - Extract (recordings only) solves the final traces of every frame with the
 *   footprints frozen.
 *
 * This module is the pure part: which stage may run now, the log of the runs
 * (for the panel and the export) and the Refine readout. The stores
 * (`pipeline-store`, `refine-store`, `pass2-store`) run the stages.
 */
import { createSignal } from 'solid-js';
import type { LibraryView } from '../workers/slow-types.ts';
import { footprintChanges, quantile, type RefineSample } from './refine-metrics.ts';

export type StageName = 'discover' | 'refine' | 'extract';

/** The names as the UI, the export and the logs spell them. */
export const STAGE_LABEL: Record<StageName, string> = {
  discover: 'Discover',
  refine: 'Refine',
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
  refine: StageActivity;
  extract: StageActivity;
  /** The slow loop's final library is out (after Discover or a Refine run). */
  finalLibrary: boolean;
  /** Cells in the newest library. */
  cells: number;
  /** Why the recorded motion and flicker cannot be replayed (null: they can). */
  replayBlocked: string | null;
}

export const LIVE_NOTE =
  'A live stream runs Discover only: there is no file to replay. Save the stream and load it as a recording later to Refine or Extract.';

/**
 * "Extract after Discover" default for recordings: off, so a Discover then
 * Refine then Extract flow does not waste an Extract run that Refine would
 * discard. Turning it on keeps the old behaviour. (Nothing persists the
 * option, so there is no saved value to respect.)
 */
export const EXTRACT_AFTER_DISCOVER_DEFAULT = false;

export const NEXT_STEP_HINT = 'Refine to let footprints settle, then Extract final traces.';

/** Show the next-step hint: a recording whose Discover is done, before any Refine or Extract. */
export function showNextStepHint(i: {
  live: boolean;
  discover: StageActivity;
  refine: StageActivity;
  extract: StageActivity;
  refineRuns: number;
}): boolean {
  return (
    !i.live &&
    i.discover === 'done' &&
    i.refine === 'idle' &&
    i.refineRuns === 0 &&
    i.extract === 'idle'
  );
}

/** Why each stage cannot start now (null: it can). */
export function stageAvailability(i: StageInput): Record<StageName, string | null> {
  const busy =
    i.discover === 'running'
      ? 'Discover is running.'
      : i.refine === 'running'
        ? 'Refine is running.'
        : i.extract === 'running'
          ? 'Extract is running.'
          : null;
  const after = (stage: string): string | null => {
    if (i.live) return LIVE_NOTE;
    if (busy) return busy;
    if (i.discover !== 'done') return `${stage} runs after Discover finishes.`;
    if (i.replayBlocked) return i.replayBlocked;
    if (!i.finalLibrary) return 'Waiting for the final library.';
    if (i.cells === 0) return 'No cells were found.';
    return null;
  };
  return {
    // A new Discover run is always possible (it starts over); never during a replay.
    discover: i.refine === 'running' || i.extract === 'running' ? busy : null,
    refine: after('Refine'),
    extract: after('Extract'),
  };
}

/** What one run of a stage did (the panel's readout, the export's `stages`). */
export interface StageRun {
  stage: StageName;
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
  /** Discover and Refine: refinements the slow loop made during the run, and per minute of recording. */
  refines?: number;
  refinesPerMin?: number | null;
  /** Discover: cells added, merged, deleted and split during the run. */
  adds?: number;
  merges?: number;
  deletes?: number;
  splits?: number;
  /** Refine: cells whose footprint changed, and their median relative change. */
  footprintsRefined?: number;
  medianFootprintChange?: number | null;
  /** Refine: the 90th percentile of the changes the run published, and the share of cells it refined. */
  changeP90?: number | null;
  refinedShare?: number;
  /** Refine: the run's series over the replay (`refine-metrics.ts`). */
  series?: readonly RefineSample[];
}

/** Runs of the stages since the last Discover start, in order. */
export function createStageLog(now: () => Date = () => new Date()) {
  const [runs, setRuns] = createSignal<StageRun[]>([]);
  /** Set when a Refine run discarded an Extract result (cleared by the next Extract). */
  const [extractInvalidated, setExtractInvalidated] = createSignal(false);

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
    if (stage === 'extract') setExtractInvalidated(false);
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
    /** A Refine run discarded the Extract result: Extract again for traces with the refined footprints. */
    extractInvalidated,
    invalidateExtract: () => setExtractInvalidated(true),
    /** A new Discover run starts over. */
    reset(): void {
      setRuns([]);
      setExtractInvalidated(false);
    },
  };
}

export type StageLog = ReturnType<typeof createStageLog>;

/** Refinements per minute of recording (null when the frame rate or the frames are unknown). */
export function perMinute(count: number, frames: number, fps: number): number | null {
  if (!(fps > 0) || !(frames > 0)) return null;
  return count / (frames / fps / 60);
}

/**
 * How much the footprints changed from `before` to `after`: per cell present
 * in both, the relative change `|a' - a| / |a|` (`footprintChanges`);
 * `refined` counts the cells whose footprint changed at all, and `median` is
 * the median change of those refined cells (null: none). Over every cell it
 * would read 0 whenever fewer than half changed.
 */
export function footprintChange(
  before: LibraryView,
  after: LibraryView,
): { refined: number; median: number | null; cells: number } {
  const { changes, cells } = footprintChanges(before, after);
  const sorted = [...changes.values()].sort((x, y) => x - y);
  return { refined: changes.size, median: quantile(sorted, 0.5), cells };
}

/** The Refine readout against the run before it. */
export interface RefineComparison {
  run: StageRun;
  /** The run before (Discover or the previous Refine). */
  previous: StageRun | null;
  /** This run's refines per minute over the previous run's (null: not comparable). */
  ratio: number | null;
  /**
   * The refine rate has stopped falling: this run published no refines, or
   * it did not rise (ratio at most 1) and its ratio to the run before is no
   * smaller than that run's ratio to its own predecessor. A rule on the
   * measured ratios only (no tuned threshold).
   */
  settled: boolean;
}

function rateRatio(a: StageRun | undefined, b: StageRun | undefined): number | null {
  const x = a?.refinesPerMin;
  const y = b?.refinesPerMin;
  if (x === null || x === undefined || y === null || y === undefined || !(y > 0)) return null;
  return x / y;
}

/** The newest finished Refine run compared with the run before it (null: none yet). */
export function refineComparison(runs: readonly StageRun[]): RefineComparison | null {
  const rated = runs.filter(
    (r) => (r.stage === 'discover' || r.stage === 'refine') && r.outcome === 'done',
  );
  const k = rated.length - 1;
  const run = rated[k];
  if (!run || run.stage !== 'refine') return null;
  const previous = rated[k - 1] ?? null;
  const ratio = rateRatio(run, previous ?? undefined);
  const before =
    k >= 2 && rated[k - 1].stage === 'refine' ? rateRatio(rated[k - 1], rated[k - 2]) : null;
  const settled =
    run.refines === 0 || (ratio !== null && before !== null && ratio <= 1 && ratio >= before);
  return { run, previous, ratio, settled };
}
