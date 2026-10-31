import { expect, test } from '@playwright/test';
import { runHarness } from './harness.ts';

test('GPU vs WASM timing, 200 fixed iterations @bench', async ({ page }) => {
  const result = await runHarness(page, 'bench');
  console.log(result.benchTable);
  expect(result.bench?.length).toBeGreaterThan(0);
});
