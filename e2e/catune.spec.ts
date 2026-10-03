import { test, expect } from './fixtures.ts';

test('CaTune: demo data loads, the WASM solver pool solves, and traces render', async ({
  page,
}) => {
  await page.goto('CaTune/');
  await expect(page.getByRole('heading', { level: 1, name: 'CaTune' })).toBeVisible();

  // Small synthetic dataset so the solve stays fast on CI runners.
  await page.getByLabel('Cells').fill('20');
  await page.getByLabel('Duration (min)').fill('2');
  await page.getByRole('button', { name: 'Load Demo Data' }).click();

  // Dashboard mounted with the generated dataset and a sized worker pool.
  const header = page.getByRole('banner');
  await expect(header.getByText(/20 cells/)).toBeVisible();
  await expect(header.getByTitle(/^[1-9]\d* solver workers allocated$/)).toBeVisible();

  // Each visible cell card goes stale -> solving -> fresh. Only a fresh
  // card's badge label reads "SNR x.x" (an errored card's label is empty,
  // though its tooltip still says "Peak SNR"), so the label proves a solve.
  const cards = page.locator('[data-cell-index]');
  await expect(cards.first()).toBeVisible();
  const cardCount = await cards.count();
  expect(cardCount).toBeGreaterThan(0);
  await expect(page.getByText(/^SNR \d+\.\d$/)).toHaveCount(cardCount);
  await expect(page.getByTitle(/^(Stale|Solving)/)).toHaveCount(0);

  // The trace charts drew, and the pool did not report a fatal failure.
  await expect(cards.first().locator('canvas').first()).toBeVisible();
  await expect(page.getByText(/solver workers failed/)).toHaveCount(0);
});
