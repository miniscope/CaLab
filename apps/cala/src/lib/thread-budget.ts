/**
 * The page's thread budget: the visit workers, the settle pool and the compress pool, all sized
 * from one logical core count (`navigator.hardwareConcurrency`, which the run record keeps as
 * `machine.hardware_concurrency`). Each sizing rule stays with its pool (`visitWorkerCount`,
 * `settlePoolSize`, `compressPoolSize`); this composes them in the order they depend on.
 */
import { compressPoolSize, type PoolWidth } from './compress-pool.ts';
import { settlePoolSize } from './settle.ts';
import { RESERVED_THREADS, visitWorkerCount } from './slow-client.ts';

/** The page's overrides of the core-count rules (URL flags) and what else takes a core. */
export interface ThreadOverrides {
  /** `?visits=N`: that many visit workers (null: from the core count). */
  visits: number | null;
  /** The history review runs (`?review`): one core is left for its worker. */
  review: boolean;
  /** `?debug&lbpool=S`: the settle pool's size (null: from the core count). */
  lbpool: number | null;
  /** `?debug&cpool=D,E[,X]`: the compress pool's widths (null: from the core count). */
  cpool: PoolWidth | null;
}

/** Workers per pool for one page. */
export interface ThreadBudget {
  /** Visit workers of the slow loop (0: the slow worker visits tiles itself). */
  visitWorkers: number;
  /** Settle look-back workers besides look-back worker 0 (the settle pool's S). */
  settlePool: number;
  /** The compress pool's widths. */
  compressPool: PoolWidth;
}

/** The thread budget for `cores` logical cores (unknown: undefined) and the page's overrides. */
export function threadBudget(cores: number | undefined, o: ThreadOverrides): ThreadBudget {
  const visitWorkers =
    o.visits !== null
      ? visitWorkerCount(o.visits + RESERVED_THREADS)
      : visitWorkerCount(cores === undefined ? undefined : cores - (o.review ? 1 : 0));
  const settlePool = settlePoolSize(cores, o.lbpool);
  const compressPool = o.cpool ?? compressPoolSize(cores, visitWorkers, settlePool);
  return { visitWorkers, settlePool, compressPool };
}
