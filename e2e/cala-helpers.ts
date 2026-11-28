import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect } from './fixtures.ts';

/**
 * Press Run on the pre-run sheet: opening a recording loads it and shows the sheet, and
 * Discover starts only on Run. The sheet is in the Run tab, which this selects first.
 */
export async function startRun(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Run', exact: true }).click();
  await page.getByTestId('run-start').click();
}

/** Show a diagnostics tab of the right-hand column: they sit in the tab row's More menu. */
export async function openMoreTab(page: Page, name: string): Promise<void> {
  await page.getByTestId('tab-more').click();
  await page.getByTestId('tab-more-menu').getByRole('menuitemradio', { name }).click();
}

/** The .npz export of the run (the run rail's Export menu), as downloaded bytes. */
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

/** Whether the archive has an entry named `name` (a local file header carries it). */
export function hasEntry(npz: Buffer, name: string): boolean {
  return npz.indexOf(name) > -1;
}
