/**
 * Background settle on the main thread, for the pipeline store: its settings (on or off, the cap
 * in re-read frames per live frame), what the slow worker is told about the cap and the pace, and
 * the settle pool of look-back workers (for the Background settle below Max, and for a Final
 * settle on the recording's factors).
 */
import { createSignal, untrack, type Accessor } from 'solid-js';
import type { LookbackFeed } from './lookback-client.ts';
import type { RunHistory } from './run-history.ts';
import { CSETTLE, csettleRate } from './settle.ts';
import type { FactorSource } from '../workers/lookback-types.ts';

/** What the Background settle control reads from the pipeline store. */
export interface BgSettleDeps {
  /** The look-back worker's feed (absent: look-back is not offered). */
  lookbackFeed?: LookbackFeed;
  /** Session of the current run with look-back (0: none). */
  lookbackSession: () => number;
  status: Accessor<string>;
  processed: Accessor<number>;
  runHistory?: RunHistory;
  /** The run's frame gate is paced (`paceFps` applies). */
  paceRun: () => boolean;
  /** The target speed, frames per second. */
  paceFps: () => number;
  /** The open source is a live stream (look-back cannot run). */
  live: () => boolean;
}

/** Background settle's settings, cap and settle pool. */
export function createBgSettleControl(deps: BgSettleDeps) {
  const { lookbackFeed, status, processed, runHistory, paceRun } = deps;
  /**
   * Settle during Discover ("Background settle", under look-back; runs only
   * while the target is below Max, at the settle governor's rate): on (the
   * default) or off, its cap in re-read frames per live frame (both take
   * effect during a run too: the cap is 0 when off), and the frames per piece
   * of an answer (0: whole answers; a URL-only knob, for the next start).
   */
  const [csettle, setCsettleSignal] = createSignal(true);
  const [csettleCeiling, setCsettleCeilingSignal] = createSignal<number>(CSETTLE.rate);
  const [csettleYield, setCsettleYield] = createSignal(0);
  /** One look-back worker: need-driven look-back first (`?debug&needfirst`; measurement only, next start). */
  const [csettleNeedFirst, setCsettleNeedFirst] = createSignal(false);
  /** The settle's cap now (0 = Off). */
  function settleCap(): number {
    return untrack(csettle) ? csettleRate(untrack(csettleCeiling)) : 0;
  }
  // `?debug&lbpoolmax`: the settle pool starts at Max too (measurement: the pooled Final settle at Max).
  let poolAtMax = false;
  const capListeners: ((cap: number, frame: number, source: string) => void)[] = [];
  /** Told when a run's settle pool starts (its workers, the frame reached); the run record's log. */
  const poolListeners: ((workers: number, frame: number, forFinal: boolean) => void)[] = [];
  /** The look-back session whose pool start was told (once per run). */
  let poolNoted = 0;

  /** The pacer as the settle governor sees it (the slow worker; 0 = Max): sent whenever it may have changed. */
  function tellSettlePace(): void {
    lookbackFeed?.pace?.(paceRun() ? deps.paceFps() : 0, untrack(status) === 'paused');
    startSettlePool();
  }
  /** The cap went from `before` to its value now: a run event while running or paused, and the listeners (the run record). */
  function noteCap(before: number, source: string): void {
    const after = settleCap();
    if (after === before) return;
    const st = untrack(status);
    const text = (c: number) => (c > 0 ? `${c} per live frame` : 'Off');
    if (st === 'running' || st === 'paused')
      runHistory?.speedSetting(
        'settle_cap',
        untrack(processed),
        before,
        after,
        `Settle cap ${text(before)} → ${text(after)}`,
      );
    for (const cb of capListeners) {
      try {
        cb(after, untrack(processed), source);
      } catch {
        // Observers only.
      }
    }
  }
  /** The settle's cap to the slow worker (during a run too), and the pool if it may now be used. */
  function tellSettleCap(): void {
    lookbackFeed?.cap?.(settleCap());
    startSettlePool();
  }
  /**
   * The settle pool starts the first time a look-back run is below Max with
   * the settle on (mid-run too); a run at Max never starts it (unless
   * `?debug&lbpoolmax`, a measurement arm).
   */
  function startSettlePool(): void {
    const st = untrack(status);
    if (st !== 'starting' && st !== 'running' && st !== 'paused') return;
    const lookbackSession = deps.lookbackSession();
    if (!lookbackSession || !(paceRun() || poolAtMax) || !(settleCap() > 0)) return;
    notePool(lookbackFeed?.startPool?.(lookbackSession) ?? 0, false);
  }
  /** The run record notes the pool's first start only (this runs on every pace or cap change). */
  function notePool(n: number, forFinal: boolean): void {
    const lookbackSession = deps.lookbackSession();
    if (n <= 0 || poolNoted === lookbackSession) return;
    poolNoted = lookbackSession;
    for (const cb of poolListeners) {
      try {
        cb(n, untrack(processed), forFinal);
      } catch {
        // Observers only.
      }
    }
  }
  /**
   * Discover of look-back run `session` ended and its Final settle reads the recording's factors
   * (`factors`): the settle pool starts now if it is not running (a run at Max, or a paced one
   * whose Background settle was off), so the settle runs on S + 1 look-back workers. S is the
   * pool size from the core count (`settlePoolSize`), never from a measured speed. The pooled
   * settle is order-dependent (footprints within noise, not bit-repeatable); its visits are not
   * (`SETTLE.visitRate`). `?debug&lbpool=0` turns it off.
   */
  function startFactorPool(session: number, factors: FactorSource['factors']): number {
    const lookbackSession = deps.lookbackSession();
    if (!lookbackSession || session !== lookbackSession) return 0;
    const n = lookbackFeed?.startFactorPool?.(session, factors) ?? 0;
    if (n > 0 && poolForFinal !== session && poolNoted !== session) poolForFinal = session;
    notePool(n, true);
    return n;
  }
  /** The look-back session whose pool was started for its Final settle (0: none). */
  let poolForFinal = 0;
  /**
   * The final library of look-back run `session` is out: a pool started for its Final settle
   * ends now, before Extract (which never uses it), so it adds nothing to Extract's memory.
   * A pool started below Max for the Background settle is left running.
   */
  function endFactorPool(session: number): number {
    if (!session || session !== poolForFinal) return 0;
    poolForFinal = 0;
    return lookbackFeed?.endPool?.(session) ?? 0;
  }

  return {
    settleCap,
    tellSettlePace,
    csettle,
    /** Background settle on or off (off = cap 0); during a run too. */
    setCsettle: (on: boolean, source = 'setting') => {
      const before = settleCap();
      setCsettleSignal(on);
      noteCap(before, source);
      tellSettleCap();
    },
    csettleCeiling,
    /** The cap, re-read frames per live frame (`CSETTLE.rates`); during a run too. */
    setCsettleCeiling: (rate: number, source = 'setting') => {
      const before = settleCap();
      setCsettleCeilingSignal(csettleRate(rate));
      noteCap(before, source);
      tellSettleCap();
    },
    csettleYield,
    csettleNeedFirst,
    setCsettleNeedFirst,
    setCsettleYield: (frames: number) =>
      setCsettleYield(Number.isFinite(frames) && frames > 0 ? Math.floor(frames) : 0),
    /** The settle pool starts at Max too (measurement). */
    setPoolAtMax(on: boolean): void {
      poolAtMax = on;
    },
    /** The settle cap in force for this run (0: Off, and 0 for a live stream). */
    capNow: () => (deps.live() ? 0 : settleCap()),
    /** Called with the new settle cap, the frame reached and what set it, whenever it changes. */
    onCapChange: (cb: (cap: number, frame: number, source: string) => void) => {
      capListeners.push(cb);
    },
    startFactorPool,
    endFactorPool,
    /** Called once per run when its settle pool starts: the pool workers and the frame reached. */
    onPoolStart: (cb: (workers: number, frame: number, forFinal: boolean) => void) => {
      poolListeners.push(cb);
    },
  };
}

/** The pipeline store's Background settle control. */
export type BgSettleControl = ReturnType<typeof createBgSettleControl>;
