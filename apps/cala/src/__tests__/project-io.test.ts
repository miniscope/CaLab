import { describe, expect, it } from 'vitest';
import { emptyIndex, emptyProject, readIndexFile, readProjectFile } from '@calab/project';
import {
  existingDir,
  fileAt,
  fileInEntries,
  projectFilesFromEntries,
  projectRunSink,
  projectZipSink,
  readProjectFiles,
  writeProject,
} from '../lib/project-io.ts';
import { createMemoryRecentStore, MAX_RECENT, rememberProject } from '../lib/recent-projects.ts';
import { MemDir } from './mem-dir.ts';

const NOW = new Date('2026-11-28T12:00:00Z');
const entry = (path: string, text: string) => ({
  file: new File([text], path.split('/').pop()!),
  relPath: path,
});

describe('project files', () => {
  it('reads the JSON files under the project folder, not the exports', async () => {
    const dir = new MemDir('calab-project');
    await dir.put('calab-project.json', '{}');
    await dir.put('calab-index.json', '{"a":1}');
    await dir.put('runs/r1_cala/calab-run.json', '{"b":2}');
    await dir.put('runs/r1_cala/d/s/cala-export.npz', 'binary');
    const files = await readProjectFiles(dir);
    expect(files.map((f) => f.path)).toEqual([
      'calab-index.json',
      'calab-project.json',
      'runs/r1_cala/calab-run.json',
    ]);
    expect(files[2].text).toBe('{"b":2}');
  });

  it('reads them from the files of a picked folder', async () => {
    const files = await projectFilesFromEntries(
      [
        entry('mouse1/calab-project/runs/r/calab-run.json', '{}'),
        entry('mouse1/calab-project/calab-project.json', '{}'),
        entry('mouse1/calab-project/runs/r/s/cala-export.npz', ''),
        entry('mouse1/a/0.avi', ''),
        entry('mouse1/a/metaData.json', '{}'),
      ],
      'mouse1',
    );
    expect(files.map((x) => x.path)).toEqual(['calab-project.json', 'runs/r/calab-run.json']);
  });

  it('finds a result file by its path in the project folder, or says what is missing', async () => {
    const dir = new MemDir('calab-project');
    await dir.put('runs/r1/s/cala-export.npz', 'npz');
    expect(await (await fileAt(dir, 'runs/r1/s/cala-export.npz')).text()).toBe('npz');
    expect(await (await fileAt(dir, './runs//r1/s/cala-export.npz')).text()).toBe('npz');
    await expect(fileAt(dir, '')).rejects.toThrow('No file was named.');
    await expect(fileAt(dir, 'runs/r2/s/cala-export.npz')).rejects.toThrow('(no r2/)');
    await expect(fileAt(dir, 'runs/r1/s/other.npz')).rejects.toThrow(
      'runs/r1/s/other.npz is not in the project folder.',
    );
    // A file where a folder is expected is not a folder.
    await expect(fileAt(dir, 'runs/r1/s/cala-export.npz/x')).rejects.toThrow('(no cala-export');
  });

  it('finds a result among the files of a picked folder', () => {
    const files = [entry('mouse1/calab-project/runs/r/s/cala-export.npz', 'x')];
    expect(fileInEntries(files, 'mouse1', 'runs/r/s/cala-export.npz').name).toBe('cala-export.npz');
    expect(() => fileInEntries(files, 'mouse1', 'runs/q/cala-export.npz')).toThrow(
      'pick the animal folder again',
    );
  });

  it('opens a folder only when it exists', async () => {
    const dir = new MemDir('mouse1');
    await dir.put('calab-project/calab-project.json', '{}');
    expect((await existingDir(dir, 'calab-project'))?.name).toBe('calab-project');
    expect(await existingDir(dir, 'other')).toBeNull();
    expect(dir.dirs.has('other')).toBe(false);
    expect(await existingDir({ kind: 'directory', name: 'x', values: dir.values }, 'a')).toBeNull();
  });

  it('writes the project file and the index, each checked and whole', async () => {
    const dir = new MemDir('calab-project');
    const project = emptyProject('mouse1', NOW, 'p-1');
    await writeProject(dir, project, emptyIndex(NOW));
    expect(dir.writes).toEqual(['calab-project.json', 'calab-index.json']);
    const p = readProjectFile(dir.files.get('calab-project.json')!);
    expect(p.ok && p.value).toEqual(project);
    expect(readIndexFile(dir.files.get('calab-index.json')!).ok).toBe(true);
    // A refused project file is never written over: only the index is.
    await writeProject(dir, null, emptyIndex(NOW));
    expect(dir.writes).toEqual(['calab-project.json', 'calab-index.json', 'calab-index.json']);
    // Nothing invalid reaches the disk.
    await expect(
      writeProject(dir, { ...project, version: 'x' } as never, emptyIndex(NOW)),
    ).rejects.toThrow();
    expect(dir.writes).toHaveLength(3);
  });

  it('makes a new run folder, never reusing one', async () => {
    const dir = new MemDir('calab-project');
    await dir.put('runs/r1/calab-run.json', 'old');
    const { id, sink, folder } = await projectRunSink(dir, 'r1', 'mouse1');
    expect([id, folder]).toEqual(['r1_2', 'runs/r1_2']);
    expect(sink.root).toBe('mouse1/runs/r1_2');
    await sink.writeText('calab-run.json', '{}');
    expect(dir.dirs.get('runs')!.dirs.get('r1')!.files.get('calab-run.json')).toBe('old');
    expect(dir.dirs.get('runs')!.dirs.get('r1_2')!.files.get('calab-run.json')).toBe('{}');
    // The runs folder is made when there is none.
    const fresh = await projectRunSink(new MemDir('calab-project'), 'r1', 'mouse1');
    expect(fresh.folder).toBe('runs/r1');
  });

  it('without the File System Access API, a run is a zip of its project tree', () => {
    const z = projectZipSink('r1_cala');
    expect([z.id, z.folder, z.sink.root, z.sink.method]).toEqual([
      'r1_cala',
      'runs/r1_cala',
      'calab-project/runs/r1_cala',
      'zip',
    ]);
  });
});

describe('recent projects', () => {
  const handle = (name: string, id = name) => ({
    name,
    isSameEntry: async (o: unknown) => (o as { id?: string }).id === id,
    id,
  });

  it('keeps the most recent first and refreshes a project opened again', async () => {
    const store = createMemoryRecentStore();
    const a = handle('mouse1', 'A');
    await rememberProject(store, a, null, new Date('2026-11-13T10:00:00Z'));
    await rememberProject(store, handle('mouse2', 'B'), null, new Date('2026-11-13T11:00:00Z'));
    await rememberProject(store, handle('mouse1', 'A'), null, new Date('2026-11-13T12:00:00Z'));
    const list = await store.list();
    expect(list.map((r) => r.name)).toEqual(['mouse1', 'mouse2']);
  });

  it('two folders with the same name stay two projects', async () => {
    const store = createMemoryRecentStore();
    await rememberProject(store, handle('mouse1', 'A'), null, new Date(1));
    await rememberProject(store, handle('mouse1', 'B'), null, new Date(2));
    expect(await store.list()).toHaveLength(2);
  });

  it('keeps at most MAX_RECENT', async () => {
    const store = createMemoryRecentStore();
    for (let i = 0; i < MAX_RECENT + 3; i++)
      await rememberProject(store, handle(`m${i}`), null, new Date(1000 * i));
    const list = await store.list();
    expect(list).toHaveLength(MAX_RECENT);
    expect(list[0].name).toBe(`m${MAX_RECENT + 2}`);
  });
});
