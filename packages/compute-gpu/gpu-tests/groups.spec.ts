import { expect, test } from '@playwright/test';
import { runHarness } from './harness.ts';

interface GroupingResult {
  groupCount: number;
  bitwiseEqual: boolean;
  streamGroups: number;
  peakResident: number;
  streamedBitwiseEqual: boolean;
  perCell: {
    relL2VsSingle: number;
    itersEqualSingle: boolean;
    relL2VsWasm: number;
    wasmIters: number;
    gpuIters: number;
    wasmConverged: boolean;
    gpuConverged: boolean;
  }[];
}

test('multi-group GPU FISTA equals single-group and matches WASM', async ({ page }) => {
  const result = await runHarness(page, 'groups');
  const g = result.grouping as GroupingResult;
  console.log(`groups=${g.groupCount} bitwiseEqual=${g.bitwiseEqual}`);
  expect(g.groupCount).toBeGreaterThanOrEqual(3);
  expect(g.bitwiseEqual).toBe(true);
  // Streamed under a 4-cell budget: groups of 2, at most 2 resident, same bits.
  expect(g.streamGroups).toBeGreaterThanOrEqual(4);
  expect(g.peakResident).toBeLessThanOrEqual(2);
  expect(g.streamedBitwiseEqual).toBe(true);
  for (const cell of g.perCell) {
    expect.soft(cell.relL2VsSingle).toBeLessThanOrEqual(1e-6);
    expect.soft(cell.itersEqualSingle).toBe(true);
    expect.soft(cell.relL2VsWasm).toBeLessThanOrEqual(1e-3);
    expect.soft(Math.abs(cell.gpuIters - cell.wasmIters) / cell.wasmIters).toBeLessThanOrEqual(0.1);
    expect.soft(cell.gpuConverged).toBe(cell.wasmConverged);
  }
});
