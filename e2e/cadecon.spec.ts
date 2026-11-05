import { test, expect } from './fixtures.ts';

test('CaDecon: synthetic data generates, a run converges, and the raster renders', async ({
  page,
}) => {
  // A full run is CPU-bound in WASM workers. GitHub's 4-vCPU runners give the
  // app 3 workers and vary ~2x in speed run to run (27 s vs >45 s observed for
  // the same seeded data), so keep the dataset small and the budget generous.
  test.setTimeout(240_000);
  await page.goto('CaDecon/');
  await expect(page.getByRole('heading', { level: 1, name: 'CaDecon' })).toBeVisible();

  // Small synthetic dataset so the run finishes quickly on CI runners.
  await page.getByLabel('Cells').fill('10');
  await page.getByLabel('Duration (min)').fill('1');
  await page.getByRole('button', { name: 'Generate' }).click();

  const header = page.getByRole('banner');
  await expect(header.getByText(/10 cells/)).toBeVisible();
  await expect(header.getByTitle(/^[1-9]\d* solver workers allocated$/)).toBeVisible();

  // Once the model-free overview is computed (in the workers, right after
  // import), the right sidebar opens on its Dataset tab: all four cards, every cell.
  const datasetTab = page.getByRole('tab', { name: 'Dataset' });
  await expect(datasetTab).toHaveAttribute('aria-selected', 'true', { timeout: 30_000 });
  const snrCard = page.getByTestId('overview-snr');
  await expect(snrCard.getByText('N 10', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('overview-heights')).toBeVisible();
  await expect(page.getByTestId('overview-baseline')).toBeVisible();
  await expect(page.getByTestId('overview-flags').getByText(/of 10 cells flagged/)).toBeVisible();
  // The analysis panel no longer carries the overview.
  await expect(page.getByRole('tab', { name: 'Asymptote' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  // The Trace Inspector shows the raw trace and its SNR before any run.
  await expect(page.getByText(/SNR: \d+(\.\d+)?/)).toBeVisible();

  await page.getByRole('button', { name: 'Start', exact: true }).click();
  // The run ends either by converging or by hitting Max Iterations; both show
  // "Complete". The kernel panel and trace inspector then have results.
  await expect(page.getByText('Complete', { exact: true })).toBeVisible({ timeout: 150_000 });
  await expect(page.getByText('No kernel data yet.')).toHaveCount(0);
  await expect(page.getByText(/PVE: \d+(\.\d+)?%/)).toBeVisible();

  // A finished run moves the panel to Results: PVE against the overview SNR,
  // one point per cell.
  await expect(page.getByRole('tab', { name: 'Results' })).toHaveAttribute('aria-selected', 'true');
  await expect(
    page.getByTestId('results-pve-snr').getByText('N 10', { exact: true }),
  ).toBeVisible();

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

/** A C-order float32 .npy file (format 1.0) for `setInputFiles`. */
function npyFloat32(data: Float32Array, shape: [number, number]): Buffer {
  let header = `{'descr': '<f4', 'fortran_order': False, 'shape': (${shape[0]}, ${shape[1]}), }`;
  // Magic (6) + version (2) + header length (2) + header, padded to 64 bytes and ending in \n.
  const unpadded = 10 + header.length + 1;
  header += ' '.repeat((64 - (unpadded % 64)) % 64) + '\n';
  const prefix = Buffer.alloc(10);
  prefix.write('\x93NUMPY', 0, 'latin1');
  prefix[6] = 1;
  prefix[7] = 0;
  prefix.writeUInt16LE(header.length, 8);
  return Buffer.concat([prefix, Buffer.from(header, 'latin1'), Buffer.from(data.buffer)]);
}

test('CaDecon: a cell with NaN samples is flagged and marked as skipped', async ({ page }) => {
  // Four cells, one minute at 30 Hz; cell 2 has three dropped frames. No run:
  // the per-cell scan happens at import, so the note shows before solving.
  const nCells = 4;
  const nT = 1800;
  const data = new Float32Array(nCells * nT);
  for (let c = 0; c < nCells; c++) {
    for (let t = 0; t < nT; t++) {
      const sinceEvent = t % 150;
      data[c * nT + t] = Math.exp(-sinceEvent / 20) + 0.05 * Math.sin(t * (1.3 + c));
    }
  }
  for (const t of [100, 101, 900]) data[2 * nT + t] = NaN;

  await page.goto('CaDecon/');
  await page
    .locator('input[type=file]')
    .first()
    .setInputFiles({
      name: 'nan-cell.npy',
      mimeType: 'application/octet-stream',
      buffer: npyFloat32(data, [nCells, nT]),
    });
  await page.getByRole('button', { name: 'Confirm' }).click();
  await page.getByText('30 Hz (miniscope / 2-photon)').click();
  await page.getByRole('button', { name: 'Confirm' }).click();

  const header = page.getByRole('banner');
  await expect(header.getByText(/4 cells/)).toBeVisible();
  // The overview flags the gap and says the solver skips it.
  await expect(page.getByTestId('overview-flags').getByText('Gaps (NaN/Inf)')).toBeVisible({
    timeout: 30_000,
  });

  // A clean cell has no note; the NaN cell says why it will not be solved.
  const note = page.getByTestId('skipped-cell-note');
  await expect(note).toHaveCount(0);
  await page.locator('select:has(option[value="2"])').first().selectOption('2');
  await expect(note).toHaveText('Skipped: trace contains 3 missing (NaN/Inf) samples');
});
