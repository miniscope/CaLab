/**
 * A Discover run's slow-loop options and the rules that tie them together, in one place.
 * `pipeline-store` sets them, the trace worker hands them to `FastLoop`, `FastLoop` puts them in
 * the slow loop's `init` (`SlowInit`), and `SlowRunner` reads them there. Every layer passes
 * them through `normalizeRunCells`, so a rule holds the same in each thread and for tests that
 * feed a layer directly.
 */
import type { CellsSettings } from '../workers/frame-types.ts';
import type { CompressFeedOptions } from './compress-feed.ts';
import type { FastLoopOptions } from './fast-loop.ts';
import type { FastLoopSetup } from './pipeline-types.ts';

/** The slow loop's run options (`CellsSettings`, `FastLoopOptions` and `SlowInit` share them). */
export interface RunCells {
  /**
   * Look-back (a recording's Discover; absent = off): the slow loop is built with the look-back
   * options (`LOOKBACK` in `lib/slow-runner.ts`, visit workers alike),
   * re-reads past frames through the look-back worker during Discover and settles after the
   * last frame (see `SlowRunner`). Stage C reports its back half's state periodically
   * (`PipelineStepResult` `backState`) for the look-back worker.
   */
  lookback?: boolean;
  /**
   * A live stream with `?factors` (never with `lookback`; absent = off): the slow loop is built
   * with `FACTOR_SETTLE` (visit workers alike) and, after the last frame, waits for the stream's
   * factors and settles on them (see `SlowRunner`).
   */
  factorSettle?: boolean;
  /** A recording with `?factors=file` (needs `lookback`): at Discover's end the settle may read the factors (`SlowRunner`). */
  factorFile?: boolean;
  /**
   * Background settle (frames only; needs `lookback`; absent = off for the run): the run may
   * settle while Discover runs. It starts the first time the target is below Max with a cap
   * above 0; the settle governor (`SettleGovernor` in `lib/settle.ts`) sets its rate. The cap
   * comes from `SlowSettleCap`, the target from `SlowSettlePace` (see `SlowRunner`).
   */
  csettle?: boolean;
  /**
   * With `csettle`: the slow worker handles an answer of re-read frames this many frames at a
   * time and gives way in between (absent or 0: the whole answer in one go).
   */
  csettleYield?: number;
  /**
   * With `csettle`, one look-back worker (no settle pool): need-driven look-back first, the
   * settle only when it asks for nothing (`?debug&needfirst`; absent: the two take turns).
   */
  csettleNeedFirst?: boolean;
  /**
   * With `lookback` or `factorSettle`: the share of the final settle pass to read, in plan order
   * (a Final-settle level, `FINAL_SETTLE_LEVELS`), in (0, 1); absent = the whole pass.
   */
  settleFraction?: number;
  /**
   * With `lookback`, a Joint run: the first stream frame of sessions 1.. (the plan's boundaries).
   * While Discover runs, look-back and Background settle re-read frames of the current session
   * only (`SlowLoop.setLookbackFloor`); the Final settle covers every session.
   */
  sessionStarts?: readonly number[];
  /**
   * The Discover visit rate's schedule (`SlowLoop.setVisitSchedule`, `discover/visitrate.rs`):
   * `fixed` (the default) or `auto`; it sets the visit cap and the target the frame-loop hold
   * aims at. Absent: no cap (`?debug&visitrate=off`).
   */
  visitSchedule?: 'auto' | 'fixed';
  /**
   * The Final settle's visit rate (`SETTLE.visitRate`), visits per settle frame fed: with visit
   * workers, a fixed count however fast the settle runs. Absent: visits whenever a visit worker
   * is free (`?debug&settlevisits=off`).
   */
  settleVisitRate?: number;
}

/**
 * The run options with their rules applied: `factorSettle` only without `lookback`;
 * `factorFile`, `csettle*` and `sessionStarts` only with `lookback`; `settleFraction` only with
 * `lookback` or `factorSettle` and below 1; `csettleYield` and `settleVisitRate` only above 0.
 * Fields that are off or at their default are absent. Idempotent; other keys of `c` are dropped.
 */
export function normalizeRunCells(c: RunCells): RunCells {
  const lookback = c.lookback === true;
  const factorSettle = c.factorSettle === true && !lookback;
  const csettle = lookback && c.csettle === true;
  return {
    ...(lookback ? { lookback } : {}),
    ...(factorSettle ? { factorSettle } : {}),
    ...(lookback && c.factorFile === true ? { factorFile: true } : {}),
    ...(csettle ? { csettle } : {}),
    ...(csettle && c.csettleYield !== undefined && c.csettleYield > 0
      ? { csettleYield: c.csettleYield }
      : {}),
    ...(csettle && c.csettleNeedFirst === true ? { csettleNeedFirst: true } : {}),
    ...((lookback || factorSettle) && c.settleFraction !== undefined && c.settleFraction < 1
      ? { settleFraction: c.settleFraction }
      : {}),
    ...(lookback && c.sessionStarts?.length ? { sessionStarts: [...c.sessionStarts] } : {}),
    ...(c.visitSchedule ? { visitSchedule: c.visitSchedule } : {}),
    ...(c.settleVisitRate !== undefined &&
    Number.isFinite(c.settleVisitRate) &&
    c.settleVisitRate > 0
      ? { settleVisitRate: c.settleVisitRate }
      : {}),
  };
}

/**
 * The trace worker's `FastLoop` options for a pipeline start. Extract (`cells.library`) solves
 * with that library and never talks to the slow loop, so it carries no run options; Discover
 * talks to it only when `slowConnected`. `boundaries`: the plan's session starts (Joint run).
 */
export function fastLoopOptions(
  setup: FastLoopSetup,
  cells: CellsSettings | undefined,
  boundaries: readonly number[] | undefined,
  slowConnected: boolean,
): FastLoopOptions {
  const replay = cells?.library !== undefined;
  return {
    ...setup,
    session: cells?.session ?? 0,
    discover: (cells?.discover ?? true) && slowConnected && !replay,
    qc: cells?.qc ?? true,
    residual: cells?.residual ?? false,
    signed: cells?.signed ?? false,
    ...(cells?.library ? { initialLibrary: cells.library } : {}),
    ...(cells && !replay
      ? normalizeRunCells({ ...cells, ...(boundaries ? { sessionStarts: boundaries } : {}) })
      : {}),
    ...(cells?.forwardBuffers ? { poolSize: cells.forwardBuffers } : {}),
  };
}

/** The `CompressFeed` options of a run that feeds the compress worker (`cells.compress`). */
export function compressFeedOptions(
  cells: CellsSettings,
  width: number,
  height: number,
): CompressFeedOptions {
  return {
    width,
    height,
    session: cells.session,
    ...(cells.compressTiling ? { tiling: cells.compressTiling } : {}),
    ...(cells.compressPool ? { pool: cells.compressPool } : {}),
    ...(cells.compressBacklogCap !== undefined ? { backlogCap: cells.compressBacklogCap } : {}),
    ...(cells.compressFrameExtract ? { frameExtract: true } : {}),
    ...(cells.compressGpu ? { gpu: true } : {}),
    ...(cells.compressGpuCheck ? { gpuCheck: cells.compressGpuCheck } : {}),
  };
}
