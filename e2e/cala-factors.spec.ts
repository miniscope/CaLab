import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.ts';
import {
  count,
  discover,
  exportNpz,
  extractResult,
  lastRefine,
  libraryCells,
  metaText,
  stageSources,
  type CalaDebug,
} from './cala-helpers.ts';
import { buildAvi, cellMovie } from '../apps/cala/src/__tests__/synth-avi.ts';

/**
 * Phase 4.1's gate on a file: a synthetic recording with cells runs
 * Discover, Refine (a raw replay, which also compresses the frames) and
 * Extract on the factors, and the export says so. With `?compress=off` the
 * same recording takes today's raw path. With `?refine=factors` Refine runs
 * until settled on the factors it makes.
 */
const FRAMES = 3000;

// The tests run one after another: each runs Discover, Refine and Extract
// in real WASM workers, and side by side they slow each other down. A failed
// test is retried on its own; the others still run.
test.describe.configure({ mode: 'default' });

/**
 * This worker's recording folders (about 27 MB each). Removed once its tests
 * are over, passed or failed; after each test the page could still hold the file.
 */
const folders: string[] = [];
test.afterAll(() => {
  for (const f of folders.splice(0)) rmSync(f, { recursive: true, force: true });
});

function cellFolder(prefix: string): string {
  const folder = mkdtempSync(join(tmpdir(), prefix));
  folders.push(folder);
  const movie = cellMovie(96, 96, FRAMES);
  writeFileSync(
    join(folder, '0.avi'),
    buildAvi({ width: 96, height: 96, frames: FRAMES, payload: (f) => movie.payload(f) }),
  );
  writeFileSync(join(folder, 'metaData.json'), '{"frameRate":"20FPS"}');
  return folder;
}

/** Open the app on a fresh cell-movie folder (`query`: extra URL parameters). */
function openFile(page: Page, query: string): () => Promise<void> {
  return async () => {
    await page.goto(`Cala/?debug${query}`);
    await page.getByTestId('folder-input').setInputFiles(cellFolder('cala-factors-e2e-'));
  };
}

test('Cala: a file runs Discover, Refine and Extract on the factors by default', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await discover(page, openFile(page, ''));
  await page.getByTestId('refine-run').click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as CalaDebug).__cala.refine.status()), {
      timeout: 120_000,
    })
    .toBe('done');
  // The Refine replay compressed the frames; Extract reads them once they are ready.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const c = (window as unknown as CalaDebug).__cala;
          return c.compress?.factors(c.pipeline.record().frames) ?? null;
        }),
      { timeout: 120_000 },
    )
    .toBe('ready');
  await expect(page.getByTestId('extract-source')).toHaveText(
    'Extract reads the factors (seconds).',
  );
  // Refine may change the library; Extract solves the cells there are now.
  const cells = await libraryCells(page);
  await page.getByTestId('pass2-run').click();
  await expect(page.getByTestId('pass2-status')).toContainText('Extract done (from the factors)', {
    timeout: 60_000,
  });
  const r = await extractResult(page);
  expect(r).toEqual({ source: 'factors', frames: FRAMES, cells });
  expect(
    await page.evaluate(() => (window as unknown as CalaDebug).__cala.compress?.error() ?? null),
  ).toBeNull();

  const bytes = await exportNpz(page);
  expect(bytes.includes('"source":"factors"')).toBe(true);
  expect(bytes.includes('"source":"raw"')).toBe(true); // Discover and Refine read the file
  expect(bytes.includes('extract_min_valid')).toBe(true);
  // Discover and Refine read the file; only the Extract record read the factors.
  expect(stageSources(metaText(bytes))).toEqual([
    ['discover', 'raw'],
    ['refine', 'raw'],
    ['extract', 'factors'],
  ]);
});

test('Cala: with compress=off a file replays the file for Extract, as before', async ({ page }) => {
  test.setTimeout(300_000);
  await discover(page, openFile(page, '&compress=off'));
  await expect(page.getByTestId('extract-source')).toHaveCount(0);
  await expect(page.getByTestId('compress-readout')).toHaveCount(0);
  const cells = await libraryCells(page);
  await page.getByTestId('pass2-run').click();
  await expect(page.getByTestId('pass2-status')).toContainText('Extract done:', {
    timeout: 120_000,
  });
  const r = await extractResult(page);
  expect(r).toEqual({ source: 'raw', frames: FRAMES, cells });
  expect(
    await page.evaluate(() => (window as unknown as CalaDebug).__cala.compress === undefined),
  ).toBe(true);
  await expect(page.getByTestId('compress-readout')).toHaveCount(0);

  const bytes = await exportNpz(page);
  const meta = metaText(bytes);
  // One raw record per stage run here (Discover, Extract), and nothing of the factors.
  expect(stageSources(meta)).toEqual([
    ['discover', 'raw'],
    ['extract', 'raw'],
  ]);
  expect(count(meta, '"source":"raw"')).toBe(2);
  expect(bytes.includes('"source":"factors"')).toBe(false);
  expect(bytes.includes('extract_min_valid')).toBe(false);
});

/** Refine runs to its end and its replay's factors become ready. */
async function refineToFactors(page: Page): Promise<void> {
  await page.getByTestId('refine-run').click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as CalaDebug).__cala.refine.status()), {
      timeout: 120_000,
    })
    .toBe('done');
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const c = (window as unknown as CalaDebug).__cala;
          return c.compress?.factors(c.pipeline.record().frames) ?? null;
        }),
      { timeout: 120_000 },
    )
    .toBe('ready');
}

test("Cala: a second tab of the app leaves the first tab's factors alone", async ({
  page,
  context,
}) => {
  test.setTimeout(400_000);
  await discover(page, openFile(page, ''));
  await refineToFactors(page);
  // Between stages the first tab holds no file open: only its lock protects its folder.
  const second = await context.newPage();
  await discover(second, openFile(second, ''));
  await page.bringToFront();
  await page.getByTestId('pass2-run').click();
  await expect(page.getByTestId('pass2-status')).toContainText('Extract done (from the factors)', {
    timeout: 60_000,
  });
  await second.close();
});

test('Cala: with refine=factors a file refines on the factors until settled, then extracts on them', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await discover(page, openFile(page, '&refine=factors'));
  await expect(page.getByTestId('refine-run')).toHaveText('Refine until settled');
  await page.getByTestId('refine-run').click();
  // No factors yet: a replay that only compresses makes them, then the iterations run.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as CalaDebug).__cala.refine.status()), {
      timeout: 180_000,
    })
    .toBe('done');
  const refine = await lastRefine(page);
  expect(refine).toMatchObject({ source: 'factors', factors: 'replay' });
  expect(['settled', 'nothing-accepted', 'cap']).toContain(refine?.stop);
  expect(refine?.iterations).toBeGreaterThan(0);
  await expect(page.getByTestId('extract-source')).toHaveText(
    'Extract reads the factors (seconds).',
  );
  const cells = await libraryCells(page);
  await page.getByTestId('pass2-run').click();
  await expect(page.getByTestId('pass2-status')).toContainText('Extract done (from the factors)', {
    timeout: 60_000,
  });
  expect(await extractResult(page)).toEqual({ source: 'factors', frames: FRAMES, cells });
  const meta = metaText(await exportNpz(page));
  expect(stageSources(meta)).toEqual([
    ['discover', 'raw'],
    ['refine', 'factors'],
    ['extract', 'factors'],
  ]);
  expect(count(meta, '"factors":"replay"')).toBe(2);
  expect(meta).not.toContain('"factors":"discover"');
});
