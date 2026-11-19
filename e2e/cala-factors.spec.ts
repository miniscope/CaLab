import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

// page.evaluate callbacks are serialized: each reads `window.__cala` itself
// (the types are erased; no `new Function`, which the page's CSP may forbid).

/** The Extract result's plain fields (its trace files do not cross to Node). */
function extractResult(page: Page) {
  return page.evaluate(() => {
    const p = (window as unknown as CalaDebug).__cala.pass2.result();
    return p && { source: p.source, frames: p.frames, cells: p.cells };
  });
}

/** Cells in the current library: what an Extract started now solves. */
function libraryCells(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as CalaDebug).__cala.cells.library()?.ids.length ?? 0,
  );
}

async function discover(page: Page, query: string): Promise<void> {
  // The export then downloads instead of asking for a place.
  await page.addInitScript(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  await page.goto(`Cala/?debug${query}`);
  await page.getByTestId('folder-input').setInputFiles(cellFolder('cala-factors-e2e-'));
  await expect(page.getByTestId('pipeline-status')).toHaveText('Done', { timeout: 120_000 });
  await expect(page.getByTestId('pass2-run')).toBeEnabled({ timeout: 60_000 });
  expect(await libraryCells(page)).toBeGreaterThan(0);
}

/** The .npz export of the run, as downloaded bytes. */
async function exportNpz(page: Page): Promise<Buffer> {
  await page.locator('[data-testid=export-menu] summary').click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-npz').click(),
  ]);
  return readFileSync((await download.path())!);
}

/**
 * The `meta_json` entry of an export, as text. The archive stores every entry
 * uncompressed (`ZipStreamWriter`, method 0) and the entry is a 1-D uint8 .npy
 * of the JSON's UTF-8 bytes, so it is found by name and read past its header.
 */
function metaText(npz: Buffer): string {
  const name = npz.indexOf('meta_json.npy');
  expect(name).toBeGreaterThan(-1);
  const magic = npz.indexOf('\x93NUMPY', name, 'latin1');
  expect(magic).toBeGreaterThan(name);
  const headerLen = npz.readUInt16LE(magic + 8);
  const header = npz.toString('latin1', magic + 10, magic + 10 + headerLen);
  const length = Number(/'shape': \((\d+),\)/.exec(header)?.[1]);
  const start = magic + 10 + headerLen;
  return npz.toString('utf8', start, start + length);
}

/** Each stage record's stage and source, in the order the run made them. */
function stageSources(meta: string): [string, string | undefined][] {
  const stages = (JSON.parse(meta) as { stages: { stage: string; source?: string }[] }).stages;
  return stages.map((s) => [s.stage, s.source]);
}

function count(text: string, part: string): number {
  return text.split(part).length - 1;
}

test('Cala: a file runs Discover, Refine and Extract on the factors by default', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await discover(page, '');
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
  await discover(page, '&compress=off');
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
  await discover(page, '');
  await refineToFactors(page);
  // Between stages the first tab holds no file open: only its lock protects its folder.
  const second = await context.newPage();
  await discover(second, '');
  await page.bringToFront();
  await page.getByTestId('pass2-run').click();
  await expect(page.getByTestId('pass2-status')).toContainText('Extract done (from the factors)', {
    timeout: 60_000,
  });
  await second.close();
});
