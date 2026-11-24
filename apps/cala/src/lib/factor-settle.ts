/**
 * The main thread's part of the Final settle on a stream's factors: once the
 * slow loop waits (`SettleStatus.waiting`) and the factors are `ready`, it
 * begins look-back worker 0 on them and tells the slow loop; when they are
 * `unusable` it ends the wait. It releases the worker at the final library
 * or at the next run. Pure: `App.tsx` carries out the actions.
 */
import type { FactorInfo, FactorState } from './compress-store.ts';
import type { FactorSource } from '../workers/lookback-types.ts';

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

/** The run history's line when the watchdog gives up. */
export const FACTOR_STALL_TEXT =
  'The compressor made no progress for 120 s: the factors are not read.';
