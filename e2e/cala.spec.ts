import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from './fixtures.ts';
import { buildAvi, pixelAt } from '../apps/cala/src/__tests__/synth-avi.ts';

/**
 * Cala is hidden from the landing page but built at /CaLab/Cala/. This drives
 * the real path: a folder of synthetic AVIs picked through the directory input,
 * parsed by the wasm AviHeader inside the frame worker, frames transferred
 * back and drawn on the canvas.
 */
test('Cala: a Miniscope folder opens, scrubs and plays from the worker', async ({ page }) => {
  await page.goto('Cala/');
  await expect(page.getByRole('heading', { level: 1, name: 'Cala' })).toBeVisible();

  const width = 24;
  const height = 16;
  // A real directory on disk, so the input's webkitRelativePath grouping is exercised.
  const dir = mkdtempSync(join(tmpdir(), 'cala-e2e-'));
  const folder = join(dir, 'My_V4_Miniscope');
  mkdirSync(folder);
  [
    { frames: 3, frameOffset: 0 },
    { frames: 3, frameOffset: 3 },
  ].forEach((o, i) => {
    writeFileSync(join(folder, `${i}.avi`), buildAvi({ width, height, ...o }));
  });
  writeFileSync(join(folder, 'metaData.json'), '{"frameRate":"20FPS","framesPerFile":3}');
  await page.getByTestId('folder-input').setInputFiles(folder);

  await expect(page.getByTestId('frame-readout')).toContainText('1 / 6');
  const header = page.getByRole('banner');
  await expect(header.getByText('24 x 16')).toBeVisible();
  await expect(header.getByText('6 frames')).toBeVisible();
  const info = page.locator('[data-panel-id="info"]');
  await expect(info).toContainText('24 x 16 px, 8-bit (GREY)');
  await expect(info).toContainText('20.00 Hz from metaData.json');
  await expect(info).toContainText('60.0 Hz (declared by the writer, ignored)');

  // Opening also runs preprocessing and motion correction in the worker.
  await expect(page.getByTestId('pipeline-status')).toHaveText('Done', { timeout: 20_000 });
  await expect(page.getByTestId('pipeline-readout')).toContainText('frame 6 / 6');
  await expect(page.getByTestId('motion-trace')).toBeVisible();
  // The cells panel is up; six frames are too few for the slow loop to start.
  await expect(page.getByTestId('cells-view')).toBeVisible();
  await expect(page.getByTestId('cells-readout')).toContainText('0 cells');

  // Raw gray levels: turn auto contrast off, scrub to global frame 4 (file 1).
  await page.getByLabel('Auto contrast').uncheck();
  await page.getByRole('slider', { name: 'Frame' }).fill('4');
  await expect(page.getByTestId('frame-readout')).toContainText('5 / 6');
  await expect
    .poll(async () =>
      page.getByTestId('frame-canvas').evaluate((el) => {
        const c = el as HTMLCanvasElement;
        const d = c.getContext('2d')!.getImageData(0, 0, 2, 2).data;
        // (x, y): (0,0) (1,0) (0,1) (1,1), red channel.
        return [d[0], d[4], d[8], d[12]];
      }),
    )
    .toEqual([pixelAt(4, 0, 0), pixelAt(4, 0, 1), pixelAt(4, 1, 0), pixelAt(4, 1, 1)]);

  // Playback runs from frame 0 and stops at the end.
  await page.getByRole('slider', { name: 'Frame' }).fill('0');
  await page.getByRole('button', { name: 'Play' }).click();
  await expect(page.getByTestId('frame-readout')).toContainText('6 / 6', { timeout: 10_000 });
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();
});

test('Cala: a folder without Miniscope videos reports an error', async ({ page }) => {
  await page.goto('Cala/');
  await page
    .getByTestId('files-input')
    .setInputFiles([{ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') }]);
  await expect(page.getByRole('alert')).toContainText('No Miniscope video found');
});
