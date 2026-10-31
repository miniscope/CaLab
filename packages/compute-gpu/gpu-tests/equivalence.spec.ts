import { expect, test } from '@playwright/test';
import { runHarness } from './harness.ts';

test('GPU FISTA reproduces the WASM banded solver', async ({ page }) => {
  const result = await runHarness(page, 'equiv');
  console.log(`Adapter: ${result.adapter}`);
  for (const c of result.equivalence ?? []) {
    console.log(
      `${c.name}: worst relL2=${c.worstRelL2.toExponential(2)} worst maxAbs=${c.worstMaxAbs.toExponential(2)} ` +
        `worst iteration diff=${(100 * c.worstIterRelDiff).toFixed(1)}%`,
    );
    for (const cell of c.perCell) {
      expect.soft(cell.relL2, c.name).toBeLessThanOrEqual(1e-3);
      expect
        .soft(Math.abs(cell.gpuIters - cell.wasmIters) / cell.wasmIters, c.name)
        .toBeLessThanOrEqual(0.1);
      expect.soft(cell.gpuConverged, c.name).toBe(cell.wasmConverged);
    }
  }
  expect(result.equivalence?.length).toBe(3);
});
