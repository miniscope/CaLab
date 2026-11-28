import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.ts';
import { buildAvi, cellMovie } from '../apps/cala/src/__tests__/synth-avi.ts';
import { exportNpz, hasEntry, metaText, startRun } from './cala-helpers.ts';

// Shorter than one compress window (600 frames): its only window is the last one, so the
// settle reads the factors whatever the machine's speed (slice 3 plan, decision 2).
const FRAMES = 590;

// In order, in one worker: with three of these runs at once, the run without factors
// (the fastest, nothing compressed) found no cells on a busy 10-core Mac.
test.describe.configure({ mode: 'default' });

function writeMovie(): string {
  const folder = join(mkdtempSync(join(tmpdir(), 'cala-factors-e2e-')), 'My_V4_Miniscope');
  mkdirSync(folder);
  const movie = cellMovie(96, 96, FRAMES);
  writeFileSync(
    join(folder, '0.avi'),
    buildAvi({ width: 96, height: 96, frames: FRAMES, payload: (f) => movie.payload(f) }),
  );
  writeFileSync(join(folder, 'metaData.json'), `{"frameRate":"20FPS","framesPerFile":${FRAMES}}`);
  return folder;
}

async function openAndExtract(page: Page, query: string): Promise<void> {
  // The export then downloads instead of asking for a place.
  await page.addInitScript(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  await page.goto(`Cala/${query}`);
  await page.getByTestId('folder-input').setInputFiles(writeMovie());
  await startRun(page);
  await expect(page.getByTestId('pass2-status')).toContainText('Extract done', {
    timeout: 180_000,
  });
}

test('Cala: with ?factors=file a recording settles and extracts on its factors', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await openAndExtract(page, '?factors=file&debug');
  await expect(page.getByTestId('pass2-status')).toContainText('Extract done (on the factors');
  const settle = await page.evaluate(() => {
    const c = (
      window as unknown as {
        __cala: {
          cells: {
            status(): {
              lookback?: { settle?: { source?: string; fed: number; done: boolean } };
            } | null;
          };
        };
      }
    ).__cala;
    return c.cells.status()?.lookback?.settle;
  });
  expect(settle).toMatchObject({ source: 'factors', done: true });
  expect(settle!.fed).toBeGreaterThan(0);
  const npz = await exportNpz(page);
  expect(hasEntry(npz, 'traces_live.npy')).toBe(false);
  const meta = metaText(npz);
  expect(meta).toContain('"format_version":7');
  expect(meta).toContain('"settle_source":"factors"');
  expect(meta).toContain('"source":"factors"');
  expect(meta).toContain('Extract read the factors');
});

test('Cala: with ?factors=0 a recording has no factors', async ({ page }) => {
  test.setTimeout(300_000);
  await openAndExtract(page, '?factors=0&debug');
  const meta = metaText(await exportNpz(page));
  expect(meta).toContain('"format_version":6');
  // (Other records carry their own `source` keys, e.g. the run history's "run start".)
  for (const key of ['settle_source', 'source_reason', '"source":"factors"', '"source":"file"'])
    expect(meta).not.toContain(key);
  expect(meta).not.toContain("A recording's factor run");
  expect(meta).not.toContain('No factors');
});

test('Cala: a ?factors=file recording compressed and extracted by a pool of three settles and extracts on its factors', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await openAndExtract(page, '?factors=file&debug&cpool=3,3,3');
  await expect(page.getByTestId('pass2-status')).toContainText('Extract done (on the factors');
  await expect(page.getByTestId('compress-readout')).toContainText('3 workers');
  const meta = metaText(await exportNpz(page));
  expect(meta).toContain('"format_version":7');
  expect(meta).toContain('"settle_source":"factors"');
  expect(meta).toContain('"compress_workers":3');
  expect(meta).toContain('"compress_workers_after":3');
  expect(meta).toContain('"extract_workers":3');
});

test('Cala: a recording without a switch is a GPU factor run; without WebGPU it reads the file and says why', async ({
  page,
}) => {
  test.setTimeout(300_000);
  // No switch: the GPU route (what ?factors=gpu asks for). CI's headless Chromium has no WebGPU
  // (no `navigator.gpu`, or no adapter): the compressor cannot start, so the settle and Extract
  // read the file. With a GPU the run may take either way.
  await openAndExtract(page, '?debug');
  const webgpu = await page.evaluate(async () => {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    return gpu !== undefined && (await gpu.requestAdapter()) !== null;
  });
  test.info().annotations.push({ type: 'webgpu', description: String(webgpu) });
  const meta = metaText(await exportNpz(page));
  expect(meta).toContain('"format_version":7');
  if (webgpu) {
    expect(meta).toMatch(/"settle_source":"(factors|file)"/);
    return;
  }
  await expect(page.getByTestId('lookback-readout')).toContainText('re-reads the file');
  await expect(page.getByTestId('lookback-readout')).toContainText(
    'GPU compressor could not start',
  );
  expect(meta).toContain('"settle_source":"file"');
  expect(meta).toContain('GPU compressor could not start');
});
