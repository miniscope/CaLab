import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from './fixtures.ts';
import { buildAvi, cellMovie } from '../apps/cala/src/__tests__/synth-avi.ts';
import {
  count,
  discover,
  exportNpz,
  extractResult,
  libraryCells,
  metaText,
  stageSources,
  type CalaDebug,
} from './cala-helpers.ts';

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

test('Cala: a live source streams through the pipeline to the end', async ({ page }) => {
  const folder = mkdtempSync(join(tmpdir(), 'cala-live-e2e-'));
  // 450 frames: past the two 200-frame warm-ups, so frames are processed live.
  writeFileSync(join(folder, '0.avi'), buildAvi({ width: 32, height: 24, frames: 450 }));
  writeFileSync(join(folder, 'metaData.json'), '{"frameRate":"20FPS"}');
  // Frame 7 is never sent: the stream stays contiguous, the gap is counted.
  await startSim(folder, ['--drop', '7']);

  // Compression off: the Discover-only live run of before phase 4.2 (no Extract offered).
  await page.goto(`Cala/?live=ws://127.0.0.1:${PORT}&debug&compress=off`);
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

  // Runs with compression on, the app default (on the offset grids of a live run).
  await page.goto(`Cala/?live=ws://127.0.0.1:${PORT}&debug`);
  await expect(page.getByTestId('pipeline-readout')).toContainText('frame 4', { timeout: 30_000 });
  await page.getByTestId('pass2-finish').click(); // "Stop the live run"
  await expect(page.getByTestId('pipeline-status')).toHaveText('Done', { timeout: 15_000 });
  await expect(page.getByTestId('pass2-status')).toContainText('Live run ended');
  // Without ?refine=factors no Refine is offered, and the note says Extract only.
  await expect(page.getByTestId('live-stage-note')).toHaveText(
    'Live run: Extract reads the factors Discover wrote during the stream; they are not claimed to meet the closeness gate.',
  );
  // A restart connects again and streams from the start.
  await page.getByRole('button', { name: 'Restart' }).click();
  await expect(page.getByTestId('pipeline-status')).not.toHaveText('Done');
  await expect(page.getByTestId('pipeline-readout')).toContainText('frame 4', { timeout: 30_000 });
  // The compression of the offset grids raised no error, stop and restart included
  // (the compress store is there: with compression on, the debug handle has it).
  expect(
    await page.evaluate(() => {
      const compress = (window as unknown as CalaDebug).__cala.compress;
      return compress ? { error: compress.error() } : 'no compress store';
    }),
  ).toEqual({ error: null });
});

test('Cala: an unreachable live source reports an error', async ({ page }) => {
  // Runs with compression on, the app default.
  await page.goto('Cala/');
  await page.getByTestId('live-url').fill(`ws://127.0.0.1:${PORT + 50}`);
  await page.getByTestId('live-connect').click();
  await expect(page.getByRole('alert')).toContainText('Could not connect', { timeout: 15_000 });
});

const LIVE_FRAMES = 3000;

test('Cala: a stream with cells extracts on its own factors after it ended, and says so', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const folder = mkdtempSync(join(tmpdir(), 'cala-live-cells-e2e-'));
  const movie = cellMovie(96, 96, LIVE_FRAMES);
  writeFileSync(
    join(folder, '0.avi'),
    buildAvi({ width: 96, height: 96, frames: LIVE_FRAMES, payload: (f) => movie.payload(f) }),
  );
  writeFileSync(join(folder, 'metaData.json'), '{"frameRate":"20FPS"}');
  // A send buffer as long as the stream: no frame is dropped, so five whole windows arrive.
  await startSim(folder, ['--buffer', String(LIVE_FRAMES)]);
  await discover(page, async () => {
    await page.goto(`Cala/?live=ws://127.0.0.1:${PORT}&debug&refine=factors`);
  });
  expect(
    await page.evaluate(() => (window as unknown as CalaDebug).__cala.pipeline.record().frames),
  ).toBe(LIVE_FRAMES);
  const note =
    'Live run: Extract and Refine read the factors Discover wrote during the stream; they are not claimed to meet the closeness gate.';
  await expect(page.getByTestId('live-stage-note')).toHaveText(note);
  await expect(page.getByTestId('extract-source')).toHaveText(
    'Extract reads the factors Discover wrote during the stream (seconds).',
  );
  // Before any stage the export is the live traces.
  const before = await exportNpz(page);
  expect(stageSources(metaText(before))).toEqual([['discover', 'raw']]);
  expect(before.includes('traces_signed')).toBe(false);

  await page.getByTestId('refine-run').click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as CalaDebug).__cala.refine.status()), {
      timeout: 180_000,
    })
    .toBe('done');
  const cells = await libraryCells(page);
  await page.getByTestId('pass2-run').click();
  await expect(page.getByTestId('pass2-status')).toContainText('Extract done (from the factors)', {
    timeout: 60_000,
  });
  expect(await extractResult(page)).toEqual({ source: 'factors', frames: LIVE_FRAMES, cells });
  const after = await exportNpz(page);
  const meta = metaText(after);
  expect(stageSources(meta)).toEqual([
    ['discover', 'raw'],
    ['refine', 'factors'],
    ['extract', 'factors'],
  ]);
  expect(count(meta, '"factors":"discover"')).toBe(2);
  expect(meta).toContain(note);
  expect(after.includes('traces_signed')).toBe(true);
  expect(after.includes('extract_min_valid')).toBe(true);
});
