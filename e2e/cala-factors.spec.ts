import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.ts';
import { buildAvi, cellMovie } from '../apps/cala/src/__tests__/synth-avi.ts';

/**
 * Phase 4.1's gate on a file: a synthetic recording with cells runs
 * Discover, Refine (a raw replay, which also compresses the frames) and
 * Extract on the factors, and the export says so. With `?compress=off` the
 * same recording takes today's raw path.
 */
interface CalaDebug {
  __cala: {
    pipeline: { status(): string; record(): { frames: number } };
    cells: { library(): { ids: Uint32Array } | null };
    refine: { status(): string };
    pass2: { result(): { source?: string; frames: number; cells: number } | null };
    compress?: { error(): string | null; factors(frames: number): string };
  };
}

const FRAMES = 3000;

function cellFolder(prefix: string): string {
  const folder = mkdtempSync(join(tmpdir(), prefix));
  const movie = cellMovie(96, 96, FRAMES);
  writeFileSync(
    join(folder, '0.avi'),
    buildAvi({ width: 96, height: 96, frames: FRAMES, payload: (f) => movie.payload(f) }),
  );
  writeFileSync(join(folder, 'metaData.json'), '{"frameRate":"20FPS"}');
  return folder;
}

// page.evaluate callbacks are serialized: each reads `window.__cala` itself
// (the types are erased; no `new Function`, which the page's CSP may forbid).

/** The Extract result's plain fields (its trace files do not cross to Node). */
function extractResult(page: Page) {
  return page.evaluate(() => {
    const p = (window as unknown as CalaDebug).__cala.pass2.result();
    return p && { source: p.source, frames: p.frames, cells: p.cells };
  });
}

async function discover(page: Page, query: string): Promise<number> {
  // The export then downloads instead of asking for a place.
  await page.addInitScript(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  await page.goto(`Cala/?debug${query}`);
  await page.getByTestId('folder-input').setInputFiles(cellFolder('cala-factors-e2e-'));
  await expect(page.getByTestId('pipeline-status')).toHaveText('Done', { timeout: 120_000 });
  await expect(page.getByTestId('pass2-run')).toBeEnabled({ timeout: 60_000 });
  const cells = await page.evaluate(
    () => (window as unknown as CalaDebug).__cala.cells.library()?.ids.length ?? 0,
  );
  expect(cells).toBeGreaterThan(0);
  return cells;
}

test('Cala: a file runs Discover, Refine and Extract on the factors by default', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const cells = await discover(page, '');
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
  await page.getByTestId('pass2-run').click();
  await expect(page.getByTestId('pass2-status')).toContainText('Extract done (from the factors)', {
    timeout: 60_000,
  });
  const r = await extractResult(page);
  expect(r).toEqual({ source: 'factors', frames: FRAMES, cells });
  expect(
    await page.evaluate(() => (window as unknown as CalaDebug).__cala.compress?.error() ?? null),
  ).toBeNull();

  await page.locator('[data-testid=export-menu] summary').click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-npz').click(),
  ]);
  const bytes = readFileSync((await download.path())!);
  expect(bytes.includes('"source":"factors"')).toBe(true);
  expect(bytes.includes('"source":"raw"')).toBe(true); // Discover and Refine read the file
});

test('Cala: with compress=off a file replays the file for Extract, as before', async ({ page }) => {
  test.setTimeout(300_000);
  const cells = await discover(page, '&compress=off');
  await expect(page.getByTestId('extract-source')).toHaveCount(0);
  await page.getByTestId('pass2-run').click();
  await expect(page.getByTestId('pass2-status')).toContainText('Extract done:', {
    timeout: 120_000,
  });
  const r = await extractResult(page);
  expect(r).toEqual({ source: 'raw', frames: FRAMES, cells });
  expect(
    await page.evaluate(() => (window as unknown as CalaDebug).__cala.compress === undefined),
  ).toBe(true);
});
