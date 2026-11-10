import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from './fixtures.ts';
import { buildAvi } from '../apps/cala/src/__tests__/synth-avi.ts';

/**
 * Cala on a live source: the simulator (`apps/cala/scripts/live-sim.mjs`)
 * streams a synthetic folder over a WebSocket at 200 fps; the app connects
 * with `?live=`, runs the pipeline on the unbounded stream (no frame count,
 * no scrubber) and ends when the stream ends. With `?compress` the frames
 * are compressed as they come; a back-fill needs cells, which this tiny
 * recording has none of, so only the compression itself is checked here.
 */
const PORT = 8790 + Number(process.env.TEST_PARALLEL_INDEX ?? 0);

let sim: ChildProcess | null = null;

test.afterEach(() => {
  sim?.kill();
  sim = null;
});

async function startSim(folder: string, extra: string[] = []): Promise<void> {
  sim = spawn(
    process.execPath,
    [
      join(import.meta.dirname, '../apps/cala/scripts/live-sim.mjs'),
      folder,
      '--port',
      String(PORT),
      '--fps',
      '200',
      ...extra,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  await new Promise<void>((resolve, reject) => {
    sim!.stdout!.on('data', (d: Buffer) => {
      if (d.toString().includes('listening')) resolve();
    });
    sim!.on('exit', (code) => reject(new Error(`live-sim exited with ${code}`)));
  });
}

test('Cala: a live source streams through the pipeline and is compressed', async ({ page }) => {
  const folder = mkdtempSync(join(tmpdir(), 'cala-live-e2e-'));
  // 450 frames: past the two 200-frame warm-ups, so frames are processed live.
  writeFileSync(join(folder, '0.avi'), buildAvi({ width: 32, height: 24, frames: 450 }));
  writeFileSync(join(folder, 'metaData.json'), '{"frameRate":"20FPS"}');
  // Frame 7 is never sent: the stream stays contiguous, the gap is counted.
  await startSim(folder, ['--drop', '7']);

  await page.goto(`Cala/?live=ws://127.0.0.1:${PORT}&compress&debug`);
  const header = page.getByRole('banner');
  await expect(header.getByText('32 x 24')).toBeVisible();
  await expect(header.getByText('live', { exact: true })).toBeVisible();
  // Unbounded: no total, no progress bar, no raw-file scrubber.
  await expect(page.getByTestId('pipeline-readout')).not.toContainText('/');
  await expect(page.getByRole('progressbar')).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Raw file' })).toHaveCount(0);
  await expect(page.getByTestId('pipeline-status')).toHaveText('Done', { timeout: 30_000 });
  await expect(page.getByTestId('pipeline-readout')).toContainText('frame 449');
  await expect(page.getByTestId('live-readout')).toContainText('449 received');
  await expect(page.getByTestId('live-readout')).toContainText('1 missed at the source');
  // Every frame went to the compress worker: one 449-frame window, no back-fill (no cells).
  await expect(page.getByTestId('compress-readout')).toContainText('1 windows', {
    timeout: 30_000,
  });
  await expect(page.getByTestId('pass2-status')).toContainText('waiting for the back-fill');
  const live = await page.evaluate(() => {
    const c = (window as unknown as { __cala: { pipeline: { live(): unknown } } }).__cala;
    return c.pipeline.live() as { received: number; missed: number; dropped: number };
  });
  expect(live).toMatchObject({ received: 449, missed: 1, dropped: 0 });
});

test('Cala: a live run can be stopped, and reconnects on restart', async ({ page }) => {
  const folder = mkdtempSync(join(tmpdir(), 'cala-live-stop-e2e-'));
  writeFileSync(join(folder, '0.avi'), buildAvi({ width: 24, height: 16, frames: 4000 }));
  writeFileSync(join(folder, 'metaData.json'), '{"frameRate":"20FPS"}');
  await startSim(folder);

  await page.goto(`Cala/?live=ws://127.0.0.1:${PORT}`);
  await expect(page.getByTestId('pipeline-readout')).toContainText('frame 4', { timeout: 30_000 });
  await page.getByTestId('pass2-finish').click(); // "Stop the live run"
  await expect(page.getByTestId('pipeline-status')).toHaveText('Done', { timeout: 15_000 });
  await expect(page.getByTestId('pass2-status')).toContainText('Live run ended');
  // A restart connects again and streams from the start.
  await page.getByRole('button', { name: 'Restart' }).click();
  await expect(page.getByTestId('pipeline-status')).not.toHaveText('Done');
  await expect(page.getByTestId('pipeline-readout')).toContainText('frame 4', { timeout: 30_000 });
});

test('Cala: an unreachable live source reports an error', async ({ page }) => {
  await page.goto('Cala/');
  await page.getByTestId('live-url').fill(`ws://127.0.0.1:${PORT + 50}`);
  await page.getByTestId('live-connect').click();
  await expect(page.getByRole('alert')).toContainText('Could not connect', { timeout: 15_000 });
});
