// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { initCalaWasm } from '../lib/cala-wasm.ts';
import { entriesFromFiles, FrameSource, type FolderEntry } from '../lib/frame-source.ts';
import { buildAvi, makeFile } from './synth-avi.ts';

beforeAll(async () => {
  await initCalaWasm(
    readFileSync(resolve(import.meta.dirname, '../../../../crates/cala/pkg/calab_cala_bg.wasm')),
  );
});

/**
 * Posting to the frame worker structured-clones the entries. A path stored as
 * a property on the File (what a dropped folder used to get) does not survive
 * that; a `FolderEntry.relPath` does, so sibling device folders stay apart.
 */
describe('folder grouping across the worker boundary', () => {
  it('loses a File property but keeps relPath through structured clone', () => {
    const file = makeFile('0.avi', new Uint8Array(4));
    Object.defineProperty(file, 'webkitRelativePath', { value: 'a/b/0.avi' });
    expect(
      (structuredClone(file) as File & { webkitRelativePath?: string }).webkitRelativePath,
    ).toBeUndefined();
    const [entry] = structuredClone(entriesFromFiles([file]));
    expect(entry.relPath).toBe('a/b/0.avi');
  });

  it('opens the right device folder from cloned entries', async () => {
    const avi = (frames: number) => buildAvi({ width: 6, height: 4, frames });
    const entries: FolderEntry[] = [
      { file: makeFile('0.avi', avi(5)), relPath: 'session/My_WebCam/0.avi' },
      { file: makeFile('0.avi', avi(3)), relPath: 'session/My_V4_Miniscope/0.avi' },
      { file: makeFile('1.avi', avi(5)), relPath: 'session/My_WebCam/1.avi' },
    ];
    const src = await FrameSource.open(structuredClone(entries));
    expect(src.frameCount).toBe(3);
    expect(src.info.ignoredFiles.sort()).toEqual([
      'session/My_WebCam/0.avi',
      'session/My_WebCam/1.avi',
    ]);
  });
});
