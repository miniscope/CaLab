/**
 * The main thread's part of the Final settle on a stream's factors: once the
 * slow loop waits (`SettleStatus.waiting`) and the factors are `ready`, it
 * begins look-back worker 0 on them and tells the slow loop; when they are
 * `unusable` it ends the wait. It releases the worker at the final library
 * or at the next run. Pure: `App.tsx` carries out the actions.
 */
import type { FactorInfo, FactorState } from './compress-store.ts';
import type { FactorSource } from '../workers/lookback-types.ts';
import { fileBehindText } from './factor-run.ts';

export interface FactorSettleInput {
  session: number;
  /** This run is a `?factors` stream (`pipeline.factorRun()`). */
  factorRun: boolean;
  /** The slow loop waits for the factors. */
  waiting: boolean;
  /** The run's final library is out. */
  final: boolean;
  state: FactorState;
  /** Why the factors cannot be read (`factorsBlocked`). */
  reason: string | null;
  info: FactorInfo | null;
  width: number;
  height: number;
}

export type FactorSettleAction =
  | { kind: 'none' }
  | { kind: 'begin'; session: number; frames: number; factors: FactorSource['factors'] }
  | { kind: 'fail'; session: number; reason: string }
  | { kind: 'release'; session: number };

export class FactorSettle {
  /** The session answered (begun or failed), and the one whose worker is begun and not released. */
  private answered = -1;
  private begun = -1;

  act(i: FactorSettleInput): FactorSettleAction {
    if (this.begun >= 0 && this.begun !== i.session) {
      const session = this.begun;
      this.begun = -1;
      return { kind: 'release', session };
    }
    if (!i.factorRun) return { kind: 'none' };
    if (i.final && this.begun === i.session) {
      this.begun = -1;
      return { kind: 'release', session: i.session };
    }
    if (!i.waiting || this.answered === i.session) return { kind: 'none' };
    if (i.state === 'ready' && i.info) {
      this.answered = i.session;
      this.begun = i.session;
      return {
        kind: 'begin',
        session: i.session,
        frames: i.info.frames,
        factors: {
          folder: i.info.folder,
          windows: i.info.windows,
          width: i.width,
          height: i.height,
        },
      };
    }
    if (i.state === 'unusable') {
      this.answered = i.session;
      return {
        kind: 'fail',
        session: i.session,
        reason: i.reason ?? 'The factors cannot be read.',
      };
    }
    return { kind: 'none' };
  }
}

export interface FileSettleInput {
  session: number;
  /** This run is a recording with `?factors=file` (`pipeline.factorFileRun()`). */
  factorFile: boolean;
  /** The slow loop asks (`SettleStatus.waiting`). */
  waiting: boolean;
  state: FactorState;
  /** Why the factors cannot be read (`fileFactorsBlocked`). */
  reason: string | null;
  info: FactorInfo | null;
  /** Frames Discover read minus frames compressed (`CompressStore.behind`). */
  behind: number;
  /** Frames per window (`COMPRESS_DEFAULTS.window`). */
  window: number;
  /** The compressor's last ms per frame (for the reason's seconds). */
  msPerFrame: number;
  /**
   * Compress workers after Discover's end (the pool's `after`; absent: 1).
   * They compress that many windows in about one window's time of one worker.
   */
  workers?: number;
  /** Wait for the factors however far behind the compressor is (`?debug&fwait`, for measurements). */
  wait?: boolean;
  width: number;
  height: number;
}

export type FileSettleAction =
  | { kind: 'none' }
  | { kind: 'factors'; session: number; frames: number; factors: FactorSource['factors'] }
  | { kind: 'file'; session: number; reason: string };

/**
 * The main thread's answer when a recording's slow loop asks at Discover's
 * end (spec decision 4, slice 3): the factors when they cover every frame;
 * at the first look, the file at once when the compressor is more than one
 * window behind; otherwise wait for that last window. One answer per session.
 */
export class FileSettleChoice {
  private answered = -1;
  private looked = -1;

  act(i: FileSettleInput): FileSettleAction {
    if (!i.factorFile || !i.waiting || this.answered === i.session) return { kind: 'none' };
    if (i.state === 'ready' && i.info) {
      this.answered = i.session;
      return {
        kind: 'factors',
        session: i.session,
        frames: i.info.frames,
        factors: {
          folder: i.info.folder,
          windows: i.info.windows,
          width: i.width,
          height: i.height,
        },
      };
    }
    if (i.state === 'unusable' || i.state === 'none') {
      this.answered = i.session;
      return {
        kind: 'file',
        session: i.session,
        reason: i.reason ?? 'The factors cannot be read.',
      };
    }
    if (this.looked !== i.session && !i.wait) {
      this.looked = i.session;
      const workers = Math.max(1, i.workers ?? 1);
      if (i.behind > i.window * workers) {
        this.answered = i.session;
        return {
          kind: 'file',
          session: i.session,
          reason: fileBehindText(i.behind, i.msPerFrame, workers),
        };
      }
    }
    return { kind: 'none' };
  }
}

/** The run history's line when the watchdog gives up. */
export const FACTOR_STALL_TEXT =
  'The compressor made no progress for 120 s: the factors are not read.';
