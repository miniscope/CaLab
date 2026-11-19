import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.ts';

/** What the e2e tests read of `window.__cala` (`?debug`). */
export interface CalaDebug {
  __cala: {
    pipeline: { status(): string; record(): { frames: number } };
    cells: {
      library(): { ids: Uint32Array } | null;
      session(): number;
      status(): { final?: boolean } | null;
    };
    refine: { status(): string };
    pass2: { result(): { source?: string; frames: number; cells: number } | null };
    compress?: { error(): string | null; factors(frames: number): string };
    stageLog: {
      last(
        stage: string,
      ): { source?: string; factors?: string; stop?: string; iterations?: number } | undefined;
    };
  };
}

// page.evaluate callbacks are serialized: each reads `window.__cala` itself
// (the types are erased; no `new Function`, which the page's CSP may forbid).

/** The Extract result's plain fields (its trace files do not cross to Node). */
export function extractResult(page: Page) {
  return page.evaluate(() => {
    const p = (window as unknown as CalaDebug).__cala.pass2.result();
    return p && { source: p.source, frames: p.frames, cells: p.cells };
  });
}

/** Cells in the current library: what an Extract started now solves. */
export function libraryCells(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as CalaDebug).__cala.cells.library()?.ids.length ?? 0,
  );
}

/** The Discover session, once that run has read the file and its final library is in (else null). */
export function discoverEnded(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const c = (window as unknown as CalaDebug).__cala;
    const ended = c.pipeline.status() === 'done' && c.cells.status()?.final === true;
    return ended ? c.cells.session() : null;
  });
}

/** The .npz export of the run, as downloaded bytes. */
export async function exportNpz(page: Page): Promise<Buffer> {
  // A second export finds the menu still open: a click on its summary would close it.
  const menu = page.getByTestId('export-menu');
  if (!(await menu.evaluate((el) => (el as HTMLDetailsElement).open))) {
    await menu.locator('summary').click();
  }
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
export function metaText(npz: Buffer): string {
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
export function stageSources(meta: string): [string, string | undefined][] {
  const stages = (JSON.parse(meta) as { stages: { stage: string; source?: string }[] }).stages;
  return stages.map((s) => [s.stage, s.source]);
}

export function count(text: string, part: string): number {
  return text.split(part).length - 1;
}

/**
 * Discover runs at most three times, until it finds cells; `open` loads the
 * page with its recording or stream.
 *
 * Why: the slow and visit workers load their WASM on Discover's first frames,
 * while the file is read as fast as it can be (or the stream arrives). On a
 * busy machine the read can end before the visits come back, and Discover then
 * ends with no cells. A Restart in the same page has the workers ready (a
 * stream connects again and starts over). These tests are about what follows
 * Discover, so they start it again as a user would.
 */
export async function discover(page: Page, open: () => Promise<void>): Promise<void> {
  // The export then downloads instead of asking for a place.
  await page.addInitScript(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  await open();
  let session = 0;
  for (let run = 1; run <= 3; run++) {
    if (run > 1) await page.getByRole('button', { name: 'Restart' }).click();
    const before = session;
    await expect
      .poll(async () => (await discoverEnded(page)) ?? 0, { timeout: 120_000 })
      .toBeGreaterThan(before);
    session = (await discoverEnded(page)) ?? 0;
    const cells = await libraryCells(page);
    // In the report: how often Discover had to start again.
    test.info().annotations.push({ type: 'discover', description: `run ${run}: ${cells} cells` });
    if (cells > 0) break;
  }
  await expect(page.getByTestId('pipeline-status')).toHaveText('Done');
  await expect(page.getByTestId('pass2-run')).toBeEnabled({ timeout: 60_000 });
  expect(await libraryCells(page)).toBeGreaterThan(0);
}

/** The newest Refine record's plain fields. */
export function lastRefine(page: Page) {
  return page.evaluate(() => {
    const r = (window as unknown as CalaDebug).__cala.stageLog.last('refine');
    return r && { source: r.source, factors: r.factors, stop: r.stop, iterations: r.iterations };
  });
}
