import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.ts';
import { buildAvi, cellMovie } from '../apps/cala/src/__tests__/synth-avi.ts';
import { exportNpz, hasEntry, metaText } from './cala-helpers.ts';

// Shorter than one compress window (600 frames): its only window is the last one, so the
// settle reads the factors whatever the machine's speed (slice 3 plan, decision 2).
const FRAMES = 590;

// In order, in one worker: with three of these runs at once, the run without the switch
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
  await expect(page.getByTestId('pass2-status')).toContainText('Extract done', {
    timeout: 180_000,
  });
}

test('Cala: with ?factors=file a recording settles and extracts on its factors', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await openAndExtract(page, '?factors=file&debug');
  await expect(page.getByTestId('pass2-status')).toContainText('Extract done (on the factors)');
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

test('Cala: without ?factors=file a recording is unchanged', async ({ page }) => {
  test.setTimeout(300_000);
  await openAndExtract(page, '?debug');
  const meta = metaText(await exportNpz(page));
  expect(meta).toContain('"format_version":6');
  // (Other records carry their own `source` keys, e.g. the run history's "run start".)
  for (const key of ['settle_source', 'source_reason', '"source":"factors"', '"source":"file"'])
    expect(meta).not.toContain(key);
});

test('Cala: a ?factors=file recording compressed by a pool of three settles and extracts on its factors', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await openAndExtract(page, '?factors=file&debug&cpool=3,3');
  await expect(page.getByTestId('pass2-status')).toContainText('Extract done (on the factors)');
  await expect(page.getByTestId('compress-readout')).toContainText('3 workers');
  const meta = metaText(await exportNpz(page));
  expect(meta).toContain('"format_version":7');
  expect(meta).toContain('"settle_source":"factors"');
  expect(meta).toContain('"compress_workers":3');
  expect(meta).toContain('"compress_workers_after":3');
});
