import { expect, test } from '@playwright/test';
import { runHarness } from './harness.ts';

interface Row {
  relL2: number;
  gpuIters: number;
  wasmIters: number;
}

test('warm starts continue FISTA momentum between WASM and GPU', async ({ page }) => {
  const result = await runHarness(page, 'warm');
  const w = result.warm as {
    wasmToGpu: Row[];
    wasmToGpuReset: Row[];
    gpuToWasm: Row[];
    lambdaChange: Row[];
    coldAtNewLambda: Row[];
  };
  for (const rows of [w.wasmToGpu, w.gpuToWasm, w.lambdaChange, w.coldAtNewLambda]) {
    for (const r of rows) {
      expect.soft(r.relL2).toBeLessThanOrEqual(1e-3);
      expect.soft(Math.abs(r.gpuIters - r.wasmIters) / r.wasmIters).toBeLessThanOrEqual(0.1);
    }
  }
});
