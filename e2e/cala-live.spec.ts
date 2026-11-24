import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from './fixtures.ts';
import { buildAvi, cellMovie } from '../apps/cala/src/__tests__/synth-avi.ts';
import { exportNpz, hasEntry, metaText } from './cala-helpers.ts';

/**
 * Cala on a live source: the simulator (`apps/cala/scripts/live-sim.mjs`)
 * streams a synthetic folder over a WebSocket at 200 fps; the app connects
 * with `?live=`, runs the pipeline on the unbounded stream (no frame count,
 * no scrubber) and ends when the stream ends.
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
      // First: the simulator takes the first of a repeated option (a test may set its own --fps).
      ...extra,
      '--fps',
      '200',
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

test('Cala: a live source streams through the pipeline to the end', async ({ page }) => {
  const folder = mkdtempSync(join(tmpdir(), 'cala-live-e2e-'));
  // 450 frames: past the two 200-frame warm-ups, so frames are processed live.
  writeFileSync(join(folder, '0.avi'), buildAvi({ width: 32, height: 24, frames: 450 }));
  writeFileSync(join(folder, 'metaData.json'), '{"frameRate":"20FPS"}');
  // Frame 7 is never sent: the stream stays contiguous, the gap is counted.
  await startSim(folder, ['--drop', '7']);

  await page.goto(`Cala/?live=ws://127.0.0.1:${PORT}&debug`);
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
  // No file to re-read: no pass 2; the run simply ends.
  await expect(page.getByTestId('pass2-status')).toContainText('Live run ended');
  await expect(page.getByTestId('pass2-run')).toHaveCount(0);
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

test('Cala: with ?factors a live stream settles and extracts on its factors after it ends', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const folder = mkdtempSync(join(tmpdir(), 'cala-live-factors-e2e-'));
  // 1,850 frames: three whole windows of 600 and a last one of 50.
  const movie = cellMovie(96, 96, 1850);
  writeFileSync(
    join(folder, '0.avi'),
    buildAvi({ width: 96, height: 96, frames: 1850, payload: (f) => movie.payload(f) }),
  );
  writeFileSync(join(folder, 'metaData.json'), '{"frameRate":"20FPS"}');
  // Slower than the other live tests: the slow loop must find cells before the stream ends.
  await startSim(folder, ['--fps', '100']);
  // The export then downloads instead of asking for a place.
  await page.addInitScript(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  await page.goto(`Cala/?live=ws://127.0.0.1:${PORT}&factors&debug`);
  await expect(page.getByTestId('pipeline-status')).toHaveText('Done', { timeout: 120_000 });
  await expect(page.getByTestId('live-stage-note')).toContainText('factors');
  // The settle on the factors, then Extract on them, by themselves.
  await expect(page.getByTestId('pass2-status')).toContainText(
    "Extract done (on the stream's factors)",
    { timeout: 180_000 },
  );
  const settle = await page.evaluate(() => {
    const c = (
      window as unknown as {
        __cala: {
          cells: {
            status(): {
              final: boolean;
              lookback?: { settle?: { source?: string; fed: number; done: boolean } };
            } | null;
          };
        };
      }
    ).__cala;
    const st = c.cells.status();
    return { final: st?.final, settle: st?.lookback?.settle };
  });
  expect(settle.final).toBe(true);
  expect(settle.settle).toMatchObject({ source: 'factors', done: true });
  expect(settle.settle!.fed).toBeGreaterThan(0);
  // The export: Extract's traces, the live traces, the sources and the note.
  const npz = await exportNpz(page);
  for (const name of ['traces.npy', 'traces_signed.npy', 'traces_live.npy'])
    expect(hasEntry(npz, name), name).toBe(true);
  const meta = metaText(npz);
  expect(meta).toContain('"format_version":7');
  expect(meta).toContain('"settle_source":"factors"');
  expect(meta).toContain('"source":"factors"');
  expect(meta).toContain('there was no file to re-read');
});
