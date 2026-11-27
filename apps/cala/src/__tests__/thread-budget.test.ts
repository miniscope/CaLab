import { describe, expect, it } from 'vitest';
import { compressPoolSize } from '../lib/compress-pool.ts';
import { settlePoolSize } from '../lib/settle.ts';
import { RESERVED_THREADS, visitWorkerCount } from '../lib/slow-client.ts';
import { threadBudget, type ThreadOverrides } from '../lib/thread-budget.ts';

const none: ThreadOverrides = { visits: null, review: false, lbpool: null, cpool: null };

describe('threadBudget', () => {
  it('matches the three pool rules on one core count', () => {
    for (const cores of [undefined, 1, 4, 6, 8, 11, 12, 16, 24, 64]) {
      for (const review of [false, true]) {
        const b = threadBudget(cores, { ...none, review });
        const visits = visitWorkerCount((cores ?? NaN) - (review ? 1 : 0));
        const settle = settlePoolSize(cores, null);
        expect(b).toEqual({
          visitWorkers: visits,
          settlePool: settle,
          compressPool: compressPoolSize(cores, visits, settle),
        });
      }
    }
  });

  it('applies each override', () => {
    const cpool = { discover: 2, after: 3, extract: 4 };
    const b = threadBudget(16, { visits: 2, review: true, lbpool: 3, cpool });
    expect(b.visitWorkers).toBe(visitWorkerCount(2 + RESERVED_THREADS));
    expect(b.settlePool).toBe(settlePoolSize(16, 3));
    expect(b.compressPool).toEqual(cpool);
    const v = threadBudget(16, { ...none, visits: 0 });
    expect(v.visitWorkers).toBe(0);
    expect(v.compressPool).toEqual(compressPoolSize(16, 0, settlePoolSize(16, null)));
  });
});
