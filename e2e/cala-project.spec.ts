import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Download, Page } from '@playwright/test';
import { test, expect } from './fixtures.ts';
import { buildAvi, cellMovie } from '../apps/cala/src/__tests__/synth-avi.ts';
import { metaText } from './cala-helpers.ts';

/**
 * An animal project of three sessions, run as a plan of a Joint step (sessions 1 and 2) and a
 * Separate step (session 3), without the File System Access API: each run downloads as a zip of
 * its `calab-project/` tree. Unzipped together, the tree holds the project file, the index and
 * one run folder per run, each with its `calab-run.json`; each export carries its run file as
 * `meta_json.run`. Opened again, the project reads the tree and warns about an old
 * `cala-results/` folder without reading it.
 *
 * With CALA_E2E_EVIDENCE set, the unzipped tree is copied to
 * ~/Projects/cala-data/runs/params-audit/pr5/example-tree/ (exports included).
 */

// As long as the config spec's run, so Discover finds the cells and Extract follows.
const FRAMES = 590;
const DAYS = ['2026_11_10', '2026_11_11', '2026_11_12'];
const STREAMS = DAYS.map((d) => `${d}/09_00_00/My_V4_Miniscope`);

function writeAnimal(root: string): void {
  const movie = cellMovie(96, 96, FRAMES);
  const avi = buildAvi({ width: 96, height: 96, frames: FRAMES, payload: (f) => movie.payload(f) });
  DAYS.forEach((d, i) => {
    const time = join(root, d, '09_00_00');
    const scope = join(time, 'My_V4_Miniscope');
    mkdirSync(scope, { recursive: true });
    writeFileSync(join(scope, '0.avi'), avi);
    writeFileSync(join(scope, 'metaData.json'), `{"frameRate":"20FPS","framesPerFile":${FRAMES}}`);
    writeFileSync(
      join(time, 'metaData.json'),
      JSON.stringify({ recordingStartTime: { msecSinceEpoch: Date.UTC(2026, 10, 10 + i, 9) } }),
    );
  });
}

/** The entries of a zip whose entries are stored (`ZipStreamWriter`, method 0). */
function unzip(buf: Buffer): Map<string, Buffer> {
  let eocd = buf.length - 22;
  while (buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    expect(buf.readUInt16LE(p + 10)).toBe(0);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    out.set(name, buf.subarray(start, start + size));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function extract(entries: Map<string, Buffer>, into: string): void {
  for (const [name, bytes] of entries) {
    const path = join(into, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
}

const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

async function selectRow(page: Page, i: number): Promise<void> {
  await page.getByTestId('project-row').nth(i).getByTestId('row-select').check();
}

test('Cala: a 3-session project runs a Joint step and a Separate step into calab-project/', async ({
  page,
}) => {
  test.setTimeout(900_000);
  const base = mkdtempSync(join(tmpdir(), 'cala-project-e2e-'));
  const animal = join(base, 'mouse1');
  writeAnimal(animal);
  // Without the File System Access API each run is a zip download.
  await page.addInitScript(() => {
    const w = window as { showDirectoryPicker?: unknown; showSaveFilePicker?: unknown };
    delete w.showDirectoryPicker;
    delete w.showSaveFilePicker;
  });
  const downloads: Download[] = [];
  page.on('download', (d) => downloads.push(d));

  await page.goto('Cala/');
  await page.getByTestId('project-input').setInputFiles(animal);
  await expect(page.getByTestId('project-row')).toHaveCount(3);
  await expect(page.getByTestId('project-row').nth(0)).toContainText(STREAMS[0]);
  await selectRow(page, 0);
  await selectRow(page, 1);
  await page.getByTestId('plan-chain').click();
  await selectRow(page, 2);
  await page.getByTestId('plan-separate').click();
  await expect(page.getByTestId('plan-group')).toHaveCount(2);
  await expect(page.getByTestId('plan-group').nth(0)).toContainText('Joint: 2 sessions');
  await page.getByTestId('plan-start').click();
  await expect.poll(() => downloads.length, { timeout: 800_000, intervals: [2000] }).toBe(2);

  // Both zips unzipped into one folder: one calab-project/ tree.
  const out = join(base, 'unzipped');
  const names: string[] = [];
  for (const d of downloads) {
    names.push(d.suggestedFilename());
    extract(unzip(readFileSync((await d.path())!)), out);
  }
  expect(names.every((n) => /^calab-project_.+_cala\.zip$/.test(n))).toBe(true);
  const tree = join(out, 'calab-project');
  const project = json(join(tree, 'calab-project.json'));
  expect(project).toMatchObject({ format: 'calab-project', version: 1 });
  expect(project.project.name).toBe('mouse1');
  // Both steps finished: they left the plan (each run file keeps its step).
  expect(project.plan.steps).toEqual([]);
  expect(project.sessions.map((s: { id: string }) => s.id)).toEqual(
    DAYS.map((d) => `${d}/09_00_00`),
  );
  const index = json(join(tree, 'calab-index.json'));
  expect(index.format).toBe('calab-index');
  expect(index.runs.map((r: { kind: string; status: string }) => [r.kind, r.status])).toEqual([
    ['joint', 'finished'],
    ['separate', 'finished'],
  ]);
  const [joint, separate] = index.runs as { id: string; folder: string }[];
  expect(index.results.map((r: { stream: string; run: string }) => [r.stream, r.run])).toEqual([
    [STREAMS[0], joint.id],
    [STREAMS[1], joint.id],
    [STREAMS[2], separate.id],
  ]);

  for (const [r, streams, kind] of [
    [joint, STREAMS.slice(0, 2), 'joint'],
    [separate, STREAMS.slice(2), 'separate'],
  ] as const) {
    expect(r.folder).toBe(`runs/${r.id}`);
    const run = json(join(tree, r.folder, 'calab-run.json'));
    expect(run.run).toMatchObject({
      id: r.id,
      app: 'cala',
      project: project.project.id,
      status: 'finished',
    });
    expect(run.run.plan.kind).toBe(kind);
    expect(run.inputs.map((i: { stream: string }) => i.stream)).toEqual(streams);
    expect(run.config.schema).toBe('cala-params');
    expect(run.results.map((x: { status: string }) => x.status)).toEqual(
      streams.map(() => 'written'),
    );
    // One library per run: one id space for all its results.
    expect(new Set(run.results.map((x: { id_space: string }) => x.id_space))).toEqual(
      new Set([`cala:${r.id}`]),
    );
    for (const res of run.results as { path: string }[]) {
      const meta = JSON.parse(metaText(readFileSync(join(tree, r.folder, res.path))));
      expect(meta.format_version).toBe(8);
      expect(meta.run.run.id).toBe(r.id);
    }
  }

  // The example tree, kept before anything else can fail.
  if (process.env.CALA_E2E_EVIDENCE) {
    const dest = join(homedir(), 'Projects/cala-data/runs/params-audit/pr5/example-tree');
    rmSync(dest, { recursive: true, force: true });
    cpSync(tree, join(dest, 'calab-project'), { recursive: true });
  }

  // Opened again: the data, the unzipped tree, and an old results folder.
  const again = join(base, 'again', 'mouse1');
  cpSync(animal, again, { recursive: true });
  cpSync(tree, join(again, 'calab-project'), { recursive: true });
  mkdirSync(join(again, 'cala-results'));
  writeFileSync(join(again, 'cala-results', 'cala-project.json'), '{"format":"cala-project"}');
  // The plan ran in the viewer: back to the table, then close the project.
  const back = page.getByTestId('back-to-project');
  if (await back.isVisible()) await back.click({ timeout: 15_000 });
  await page.getByTestId('project-close').click({ timeout: 15_000 });
  await page.getByTestId('project-input').setInputFiles(again);
  await expect(page.getByTestId('project-row')).toHaveCount(3);
  await expect(page.getByTestId('project-warning')).toContainText(
    'mouse1/cala-results/ was made by an older cala',
  );
  const rows = page.getByTestId('project-row');
  await expect(rows.nth(0).getByTestId('cell-current')).toContainText(`run ${joint.id}`);
  await expect(rows.nth(2).getByTestId('cell-current')).toContainText(`run ${separate.id}`);
  await expect(rows.nth(0).getByTestId('cell-ids')).toHaveText(
    await rows.nth(1).getByTestId('cell-ids').innerText(),
  );

  rmSync(base, { recursive: true, force: true });
});
