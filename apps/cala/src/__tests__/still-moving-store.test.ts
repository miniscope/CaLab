// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createRoot } from 'solid-js';
import { createCellStore } from '../lib/cell-store.ts';
import type { SlowStatus } from '../workers/slow-types.ts';

describe('cell store: still-moving hint', () => {
  it('keeps the newest hint by cell id, clears it on reset, and reads one cell', () => {
    createRoot((dispose) => {
      const cells = createCellStore();
      cells.reset(1);
      expect(cells.stillMoving().size).toBe(0);
      expect(cells.stillMovingRatio(7)).toBeUndefined();
      const status = (extra: Partial<SlowStatus>): SlowStatus =>
        ({
          frame: 0,
          observed: 0,
          skipped: 0,
          cells: 0,
          version: 0,
          counters: { adds: 0, merges: 0 },
          final: false,
          run: 1,
          editScope: 'discover',
          batchMs: 0,
          maxStepMs: 0,
          ...extra,
        }) as SlowStatus;
      cells.onSlowMessage({
        type: 'status',
        session: 1,
        status: status({ stillMoving: Float64Array.of(7, 0.4, 9, 5) }),
      });
      expect(cells.stillMovingRatio(7)).toBeCloseTo(0.4);
      expect(cells.stillMovingRatio(9)).toBe(5);
      // A status without a hint leaves the last one in place.
      cells.onSlowMessage({ type: 'status', session: 1, status: status({}) });
      expect(cells.stillMovingRatio(7)).toBeCloseTo(0.4);
      // A Refine run (run > 1) clears it, and its own status does not bring one back.
      cells.onSlowMessage({ type: 'status', session: 1, status: status({ run: 2 }) });
      expect(cells.stillMoving().size).toBe(0);
      cells.reset(2);
      expect(cells.stillMoving().size).toBe(0);
      dispose();
    });
  });
});
