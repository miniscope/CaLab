import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Download, Page } from '@playwright/test';
import { test, expect } from './fixtures.ts';
import { buildAvi, cellMovie } from '../apps/cala/src/__tests__/synth-avi.ts';
import { metaText } from './cala-helpers.ts';

/**
 * Every folder opens as a project (`apps/cala/docs/projects.md`). A single recording is a project
 * of one session: it opens on its pre-run sheet, and Run writes its run into `calab-project/`.
 *
 * An animal project of three sessions, run as a plan of a Joint step (sessions 1 and 2) and a
 * Separate step (session 3), without the File System Access API: each run downloads as a zip of
 * its `calab-project/` tree. Unzipped together, the tree holds the project file, the index and
 * one run folder per run, each with its `calab-run.json`; each export carries its run file as
 * `meta_json.run`. Opened again, the project reads the tree and warns about an old
 * `cala-results/` folder without reading it.
 *
 * With CALA_E2E_EVIDENCE set, the unzipped tree is copied to
 * ~/Projects/cala-data/runs/params-audit/pr5/example-tree/ (exports included), and screenshots of
 * the open flow (one recording, an animal folder; 1440 and 400 px wide) go to `…/pr6/`.
 */
const EVIDENCE = process.env.CALA_E2E_EVIDENCE
  ? join(homedir(), 'Projects/cala-data/runs/params-audit')
  : null;

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

/** Without the File System Access API: each run is a zip download. */
async function noFileSystemAccess(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as { showDirectoryPicker?: unknown; showSaveFilePicker?: unknown };
    delete w.showDirectoryPicker;
    delete w.showSaveFilePicker;
  });
}

/** Screenshots of the open flow, loaded at 1440 and at 400 px wide (evidence only). */
test('Cala: the open flow, as screenshots', async ({ page }) => {
  test.skip(!EVIDENCE, 'evidence only (CALA_E2E_EVIDENCE)');
  const base = mkdtempSync(join(tmpdir(), 'cala-shots-e2e-'));
  const single = join(base, 'My_V4_Miniscope');
  mkdirSync(single);
  writeFileSync(join(single, '0.avi'), buildAvi({ width: 96, height: 96, frames: 3 }));
  writeFileSync(join(single, 'metaData.json'), '{"frameRate":"20FPS"}');
  const animal = join(base, 'mouse1');
  writeAnimal(animal);
  await noFileSystemAccess(page);
  const shot = (name: string, width: number) =>
    page.screenshot({ path: join(EVIDENCE!, 'pr6', `${name}-${width}.png`), fullPage: true });
  for (const width of [1440, 400]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('Cala/');
    await shot('start', width);
    await page.getByTestId('folder-input').setInputFiles(single);
    await expect(page.getByTestId('prerun-sheet')).toBeVisible();
    await shot('single-recording', width);
    await page.getByTestId('back-to-project').click();
    await expect(page.getByTestId('project-row')).toHaveCount(1);
    await shot('single-recording-project', width);
    await page.goto('Cala/');
    await page.getByTestId('folder-input').setInputFiles(animal);
    await expect(page.getByTestId('project-row')).toHaveCount(3);
    await shot('animal-folder', width);
  }
  rmSync(base, { recursive: true, force: true });
});

test('Cala: one recording is a one-session project; Run writes its run into calab-project/', async ({
  page,
}) => {
  test.setTimeout(400_000);
  const base = mkdtempSync(join(tmpdir(), 'cala-single-e2e-'));
  const folder = join(base, 'My_V4_Miniscope');
  mkdirSync(folder);
  const movie = cellMovie(96, 96, FRAMES);
  writeFileSync(
    join(folder, '0.avi'),
    buildAvi({ width: 96, height: 96, frames: FRAMES, payload: (f) => movie.payload(f) }),
  );
  writeFileSync(join(folder, 'metaData.json'), `{"frameRate":"20FPS","framesPerFile":${FRAMES}}`);
  await noFileSystemAccess(page);
  const downloads: Download[] = [];
  page.on('download', (d) => downloads.push(d));

  await page.goto('Cala/');
  await page.getByTestId('folder-input').setInputFiles(folder);
  // No table: the recording opens on its pre-run sheet; the project is one click away.
  await expect(page.getByTestId('prerun-sheet')).toBeVisible();
  await expect(page.getByTestId('project-row')).toHaveCount(0);
  await expect(page.getByTestId('back-to-project')).toHaveText('Project');
  await page.getByTestId('run-start').click();
  await expect(page.getByTestId('session-run-root')).toContainText('calab-project/runs/');
  await expect.poll(() => downloads.length, { timeout: 360_000, intervals: [2000] }).toBe(1);
  expect(downloads[0].suggestedFilename()).toMatch(/^calab-project_.+_cala\.zip$/);
  const out = join(base, 'unzipped');
  extract(unzip(readFileSync((await downloads[0].path())!)), out);
  const tree = join(out, 'calab-project');
  const project = json(join(tree, 'calab-project.json'));
  expect(project.project.name).toBe('My_V4_Miniscope');
  expect(project.sessions).toMatchObject([{ id: '.', streams: [{ id: '.', role: 'miniscope' }] }]);
  expect(project.plan.steps).toEqual([]);
  const index = json(join(tree, 'calab-index.json'));
  expect(index.runs).toHaveLength(1);
  const { id, folder: runFolder } = index.runs[0] as { id: string; folder: string };
  const run = json(join(tree, runFolder, 'calab-run.json'));
  expect(run.run).toMatchObject({ id, status: 'finished', project: project.project.id });
  expect(run.run.plan.kind).toBe('separate');
  expect(run.inputs).toMatchObject([{ role: 'video', stream: '.' }]);
  expect(run.results).toMatchObject([{ stream: '.', status: 'written', path: 'cala-export.npz' }]);
  const meta = JSON.parse(metaText(readFileSync(join(tree, runFolder, 'cala-export.npz'))));
  expect(meta.run.run.id).toBe(id);
  // Restart after the run ended: a new run of the same step, written in full.
  await page.getByRole('button', { name: 'Restart' }).click();
  await expect.poll(() => downloads.length, { timeout: 360_000, intervals: [2000] }).toBe(2);
  const out2 = join(base, 'unzipped2');
  extract(unzip(readFileSync((await downloads[1].path())!)), out2);
  const index2 = json(join(out2, 'calab-project', 'calab-index.json'));
  expect(index2.runs.map((r: { id: string; status: string }) => r.status)).toEqual([
    'finished',
    'finished',
  ]);
  const second = index2.runs[1] as { id: string; folder: string };
  expect(second.id).not.toBe(id);
  const run2 = json(join(out2, 'calab-project', second.folder, 'calab-run.json'));
  expect(run2.results).toMatchObject([{ stream: '.', status: 'written' }]);
  // The table of the one-session project lists its run.
  await page.getByTestId('back-to-project').click();
  await expect(page.getByTestId('project-row')).toHaveCount(1);
  rmSync(base, { recursive: true, force: true });
});

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
  await noFileSystemAccess(page);
  const downloads: Download[] = [];
  page.on('download', (d) => downloads.push(d));

  await page.goto('Cala/');
  await page.getByTestId('folder-input').setInputFiles(animal);
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
  if (EVIDENCE) {
    const dest = join(EVIDENCE, 'pr5/example-tree');
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
  await page.getByTestId('folder-input').setInputFiles(again);
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

/** A recording folder `<base>/<name>` of the cell movie. */
function writeRecording(base: string, name: string): string {
  const folder = join(base, name);
  mkdirSync(folder, { recursive: true });
  const movie = cellMovie(96, 96, FRAMES);
  writeFileSync(
    join(folder, '0.avi'),
    buildAvi({ width: 96, height: 96, frames: FRAMES, payload: (f) => movie.payload(f) }),
  );
  writeFileSync(join(folder, 'metaData.json'), `{"frameRate":"20FPS","framesPerFile":${FRAMES}}`);
  return folder;
}

/** Set a number field of the sheet (Advanced opened first) and leave it. */
async function setField(page: Page, pointer: string, value: string): Promise<void> {
  const sheet = page.getByTestId('run-settings');
  const advanced = sheet.getByTestId('params-advanced');
  if (!(await advanced.evaluate((el) => (el as HTMLDetailsElement).open)))
    await advanced.locator('summary').click();
  const input = sheet.locator(`#param-${pointer.slice(1).replace(/\//g, '-')}`);
  await input.fill(value);
  await input.press('Tab');
}

const badge = (page: Page, pointer: string) =>
  page.getByTestId(`param-source-${pointer.slice(1).replace(/\//g, '-')}`);

/** The only run of an unzipped download: its folder and run file. */
function onlyRun(tree: string) {
  const index = json(join(tree, 'calab-index.json'));
  expect(index.runs).toHaveLength(1);
  const folder = (index.runs[0] as { folder: string }).folder;
  return { folder, run: json(join(tree, folder, 'calab-run.json')) };
}

test("Cala: project defaults and a session's own value reach the run file; its export loads as a config", async ({
  page,
}) => {
  test.setTimeout(900_000);
  const base = mkdtempSync(join(tmpdir(), 'cala-layers-e2e-'));
  const folder = writeRecording(base, 'My_V4_Miniscope');
  await noFileSystemAccess(page);
  const downloads: Download[] = [];
  page.on('download', (d) => downloads.push(d));

  await page.goto('Cala/');
  await page.getByTestId('folder-input').setInputFiles(folder);
  await expect(page.getByTestId('prerun-sheet')).toBeVisible();
  // Two values saved as the project's defaults; then this session's own diameter over one.
  await setField(page, '/scales/cell_diameter_px', '12');
  await setField(page, '/motion/template_tau_s', '30');
  await expect(badge(page, '/scales/cell_diameter_px')).toHaveText('set');
  await page.getByTestId('config-save-defaults').click();
  await expect(badge(page, '/scales/cell_diameter_px')).toHaveText('project');
  await expect(badge(page, '/motion/template_tau_s')).toHaveText('project');
  await setField(page, '/scales/cell_diameter_px', '14');
  await page.getByTestId('config-session-only').check();
  await expect(page.getByTestId('config-save-defaults')).toHaveText('Save for this session');
  await page.getByTestId('config-save-defaults').click();
  await expect(badge(page, '/scales/cell_diameter_px')).toHaveText('stream');
  await expect(page.getByTestId('config-save-defaults')).toBeDisabled();

  // Without the File System Access API a reload keeps them (browser storage): the same folder
  // picked again.
  await page.reload();
  await page.getByTestId('folder-input').setInputFiles(folder);
  await expect(page.getByTestId('prerun-sheet')).toBeVisible();
  await page.getByTestId('params-advanced').locator('summary').click();
  await expect(badge(page, '/scales/cell_diameter_px')).toHaveText('stream');
  await expect(badge(page, '/motion/template_tau_s')).toHaveText('project');

  await page.getByTestId('run-start').click();
  await expect.poll(() => downloads.length, { timeout: 360_000, intervals: [2000] }).toBe(1);
  const out = join(base, 'unzipped');
  extract(unzip(readFileSync((await downloads[0].path())!)), out);
  const tree = join(out, 'calab-project');
  const project = json(join(tree, 'calab-project.json'));
  expect(project.defaults.cala).toEqual({
    params_version: 1,
    params: { scales: { cell_diameter_px: 12 }, motion: { template_tau_s: 30 } },
  });
  expect(project.sessions[0].streams[0].overrides).toEqual({
    cala: { scales: { cell_diameter_px: 14 } },
  });
  const { folder: runFolder, run } = onlyRun(tree);
  expect(run.config.requested).toMatchObject({
    scales: { cell_diameter_px: 14 },
    motion: { template_tau_s: 30 },
  });
  expect(run.config.sources).toMatchObject({
    '/scales/cell_diameter_px': 'stream',
    '/motion/template_tau_s': 'project',
  });
  expect(run.config.resolved.scales.cell_diameter_px).toBe(14);
  expect(run.config.resolved.motion.template_tau_s).toBe(30);

  // A new recording takes that run's settings from its export: what it asked for, and on
  // request what its data set (the frame rate).
  const other = writeRecording(base, 'Other_Miniscope');
  await page.goto('Cala/');
  await page.getByTestId('folder-input').setInputFiles(other);
  await expect(page.getByTestId('prerun-sheet')).toBeVisible();
  await expect(page.getByTestId('config-count')).toHaveText('All defaults');
  await page
    .getByTestId('config-load-input')
    .setInputFiles(join(tree, runFolder, 'cala-export.npz'));
  await expect(page.getByTestId('config-file')).toContainText('cala-export.npz');
  await page.getByTestId('params-advanced').locator('summary').click();
  await expect(badge(page, '/scales/cell_diameter_px')).toHaveText('file');
  await expect(badge(page, '/motion/template_tau_s')).toHaveText('file');
  await expect(page.getByTestId('config-count')).toHaveText('2 set');
  await page.getByTestId('config-pin-derived').check();
  await expect(page.getByTestId('config-count')).toHaveText('3 set');
  await page.getByTestId('config-pin-derived').uncheck();
  await expect(page.getByTestId('config-count')).toHaveText('2 set');
  await page.getByTestId('run-start').click();
  await expect.poll(() => downloads.length, { timeout: 360_000, intervals: [2000] }).toBe(2);
  const out2 = join(base, 'unzipped2');
  extract(unzip(readFileSync((await downloads[1].path())!)), out2);
  const second = onlyRun(join(out2, 'calab-project')).run;
  expect(second.config.sources).toEqual({
    '/scales/cell_diameter_px': 'file:cala-export.npz',
    '/motion/template_tau_s': 'file:cala-export.npz',
  });
  rmSync(base, { recursive: true, force: true });
});

test('Cala: without the File System Access API a reload keeps the plan, and a run cut short leaves its run file', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const base = mkdtempSync(join(tmpdir(), 'cala-reload-e2e-'));
  const animal = join(base, 'mouse1');
  writeAnimal(animal);
  await noFileSystemAccess(page);
  await page.goto('Cala/');
  await page.getByTestId('folder-input').setInputFiles(animal);
  await expect(page.getByTestId('project-row')).toHaveCount(3);
  await selectRow(page, 0);
  await selectRow(page, 1);
  await page.getByTestId('plan-chain').click();
  await selectRow(page, 2);
  await page.getByTestId('plan-separate').click();
  await expect(page.getByTestId('plan-group')).toHaveCount(2);
  // The draft project file in IndexedDB holds the plan.
  const draftSteps = () =>
    page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          const req = indexedDB.open('calab-drafts', 1);
          req.onsuccess = () => {
            const all = req.result.transaction('projects').objectStore('projects').getAll();
            all.onsuccess = () =>
              resolve(
                Math.max(
                  0,
                  ...(all.result as { project: { plan: { steps: unknown[] } } }[]).map(
                    (r) => r.project.plan.steps.length,
                  ),
                ),
              );
            all.onerror = () => resolve(-1);
          };
          req.onerror = () => resolve(-2);
        }),
    );
  await expect.poll(draftSteps).toBe(2);

  await page.reload();
  await page.getByTestId('folder-input').setInputFiles(animal);
  await expect(page.getByTestId('plan-group')).toHaveCount(2);
  await expect(page.getByTestId('plan-group').nth(0)).toContainText('Joint: 2 sessions');
  await expect(page.getByTestId('project-warning').first()).toContainText('browser storage');

  // A run starts (its run file is written before its first frame), then the tab goes away.
  await page.getByTestId('plan-start').click();
  await expect(page.getByTestId('session-run-root')).toContainText('calab-project/runs/');
  // Its copy in browser storage (OPFS) is there before the first frame.
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const root = await navigator.storage.getDirectory();
          const top = await root.getDirectoryHandle('calab-saved-runs').catch(() => null);
          if (!top) return 0;
          let n = 0;
          for await (const d of (
            top as unknown as { values(): AsyncIterable<FileSystemDirectoryHandle> }
          ).values())
            for await (const f of (d as unknown as { values(): AsyncIterable<unknown> }).values())
              if (f) n++;
          return n;
        }),
      { timeout: 60_000 },
    )
    .toBe(1);
  await page.reload();
  await page.getByTestId('folder-input').setInputFiles(animal);
  await expect(page.getByTestId('saved-run')).toHaveCount(1);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('saved-run-download').click(),
  ]);
  const run = JSON.parse(readFileSync((await download.path())!, 'utf8'));
  expect(run.format).toBe('calab-run');
  expect(['planned', 'running']).toContain(run.run.status);
  expect(run.run.plan.kind).toBe('joint');
  // The step that was running is stopped, not stuck: both steps can start again.
  await expect(page.getByTestId('plan-group')).toHaveCount(2);
  await expect(page.getByTestId('plan-start')).toBeEnabled();
  rmSync(base, { recursive: true, force: true });
});
