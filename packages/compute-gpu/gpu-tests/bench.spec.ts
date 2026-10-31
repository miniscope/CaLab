import { expect, test } from '@playwright/test';
import { runHarness } from './harness.ts';

test('GPU vs WASM timing, 200 fixed iterations @bench', async ({ page }) => {
  const result = await runHarness(page, 'bench');
  console.log(result.benchTable);
  expect(result.bench?.length).toBeGreaterThan(0);
  for (const row of (result.bench ?? []) as { N: number; T: number; skipped?: string }[]) {
    expect(row.skipped, `N=${row.N} T=${row.T}`).toBeUndefined();
  }
});

test('one full-coverage CaDecon pass, N=1024 T=270000, converged @bench', async ({ page }) => {
  const result = await runHarness(page, 'full');
  console.log(JSON.stringify(result.full));
  expect(result.full).toBeDefined();
});
