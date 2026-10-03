import { test, expect } from './fixtures.ts';

test('CaDecon: synthetic data generates, a run converges, and the raster renders', async ({
  page,
}) => {
  await page.goto('CaDecon/');
  await expect(page.getByRole('heading', { level: 1, name: 'CaDecon' })).toBeVisible();

  // Small synthetic dataset so the run finishes quickly on CI runners.
  await page.getByLabel('Cells').fill('20');
  await page.getByLabel('Duration (min)').fill('2');
  await page.getByRole('button', { name: 'Generate' }).click();

  const header = page.getByRole('banner');
  await expect(header.getByText(/20 cells/)).toBeVisible();
  await expect(header.getByTitle(/^[1-9]\d* solver workers allocated$/)).toBeVisible();

  await page.getByRole('button', { name: 'Start', exact: true }).click();

  // The run ends either by converging or by hitting Max Iterations; both show
  // "Complete". The kernel panel and trace inspector then have results.
  await expect(page.getByText('Complete', { exact: true })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText('No kernel data yet.')).toHaveCount(0);
  await expect(page.getByText(/PVE: \d+(\.\d+)?%/)).toBeVisible();

  // The raster heatmap is a 2D canvas: it must be sized and contain pixels.
  // (`.raster-canvas` is the only handle on it; canvases have no role.)
  const raster = page.locator('canvas.raster-canvas');
  await expect(raster).toBeVisible();
  const painted = await raster.evaluate((el) => {
    const canvas = el as HTMLCanvasElement;
    const ctx = canvas.getContext('2d');
    if (!ctx || canvas.width === 0 || canvas.height === 0) return 0;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let opaque = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) opaque++;
    return opaque / (canvas.width * canvas.height);
  });
  expect(painted, 'fraction of raster pixels drawn').toBeGreaterThan(0.1);
});
