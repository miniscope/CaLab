import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from './fixtures.ts';
import { buildAvi, cellMovie } from '../apps/cala/src/__tests__/synth-avi.ts';
import { exportNpz, metaText, startRun } from './cala-helpers.ts';

// As long as the factors spec's runs, so Discover finds the cells and Extract follows.
const FRAMES = 590;

function writeMovie(dir: string): string {
  const folder = join(dir, 'My_V4_Miniscope');
  mkdirSync(folder);
  const movie = cellMovie(96, 96, FRAMES);
  writeFileSync(
    join(folder, '0.avi'),
    buildAvi({ width: 96, height: 96, frames: FRAMES, payload: (f) => movie.payload(f) }),
  );
  writeFileSync(join(folder, 'metaData.json'), `{"frameRate":"20FPS","framesPerFile":${FRAMES}}`);
  return folder;
}

/**
 * A config file sets the cell diameter the way the sheet leads with: µm at the sample through
 * the microscope's optics. The run then carries it: the export's run file (`meta_json.run`) has
 * the request, where it came from, and the diameter in pixels the engine used.
 */
test('Cala: a config file sets the cell diameter, and the run carries it', async ({ page }) => {
  test.setTimeout(240_000);
  const dir = mkdtempSync(join(tmpdir(), 'cala-config-e2e-'));
  const config = join(dir, 'cala-d12.json');
  writeFileSync(
    config,
    `// 2 µm per pixel: 24 µm is 12 px, about the size of the movie's cells.
{
  "format": "calab-config", "version": 1, "app": "cala", "params_version": 1,
  "params": {
    "optics": { "sensor_pixel_um": 4, "magnification": 2 },
    "scales": { "expected_cell_diameter_um": 24 },
    "discover": { "acept_z": 4 }
  }
}`,
  );
  // The export then downloads instead of asking for a place.
  await page.addInitScript(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  await page.goto('Cala/');
  await page.getByTestId('folder-input').setInputFiles(writeMovie(dir));
  await page.getByRole('tab', { name: 'Run', exact: true }).click();
  const sheet = page.getByTestId('run-settings');
  await expect(sheet.getByTestId('derived-diameter')).toContainText('the run uses 10 px');

  await sheet.getByTestId('config-load-input').setInputFiles(config);
  await expect(sheet.getByTestId('config-file')).toContainText('cala-d12.json');
  await expect(sheet.getByTestId('derived-diameter')).toContainText('12 px');
  await expect(sheet.getByTestId('expected-cell-diameter')).toHaveValue('24');
  await expect(sheet.getByTestId('param-source-scales-expected_cell_diameter_um')).toHaveText(
    'file',
  );
  // The misspelt key is named, with the field it probably meant, and not used.
  await expect(sheet.getByTestId('config-warnings')).toContainText('/discover/acept_z');
  await expect(sheet.getByTestId('config-warnings')).toContainText('accept_z');

  await startRun(page);
  await expect(page.getByTestId('pass2-status')).toContainText('Extract done', {
    timeout: 180_000,
  });
  await expect(page.getByTestId('settings-summary')).toContainText('Expected cell diameter 24 µm');
  const meta = metaText(await exportNpz(page));
  expect(meta).toContain('"cell_diameter":{"px":12,"source":"optics","um_per_px":2}');
  expect(meta).toContain('"/scales/expected_cell_diameter_um":"file:cala-d12.json"');
  expect(meta).toContain('"requested":{"optics":{"sensor_pixel_um":4,"magnification":2}');
  // The misspelt key is kept in the run file's config as ignored, and nowhere else.
  const run = JSON.parse(meta).run;
  expect(run.format).toBe('calab-run');
  expect(run.config.ignored).toEqual(['/discover/acept_z']);
  expect(meta.split('acept_z')).toHaveLength(2);
});
