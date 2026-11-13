import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  entriesFromDirectoryHandle,
  pickDirectory,
  supportsDirectoryPicker,
  type DirHandleLike,
  type FileHandleLike,
} from '../lib/directory-picker.ts';

function file(name: string, body = 'x'): FileHandleLike {
  return { kind: 'file', name, getFile: async () => new File([body], name) };
}

function dir(name: string, children: Array<DirHandleLike | FileHandleLike>): DirHandleLike {
  return {
    kind: 'directory',
    name,
    async *values() {
      yield* children;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as { showDirectoryPicker?: unknown }).showDirectoryPicker;
});

describe('entriesFromDirectoryHandle', () => {
  it('walks nested folders with root-prefixed paths in name order', async () => {
    const root = dir('rec', [
      file('metaData.json'),
      dir('sub', [file('b.avi'), dir('deep', [file('z.csv')]), file('a.avi')]),
      file('1.avi'),
      file('0.avi'),
    ]);
    const entries = await entriesFromDirectoryHandle(root);
    expect(entries.map((e) => e.relPath)).toEqual([
      'rec/0.avi',
      'rec/1.avi',
      'rec/metaData.json',
      'rec/sub/a.avi',
      'rec/sub/b.avi',
      'rec/sub/deep/z.csv',
    ]);
    expect(entries.map((e) => e.file.name)).toEqual([
      '0.avi',
      '1.avi',
      'metaData.json',
      'a.avi',
      'b.avi',
      'z.csv',
    ]);
  });

  it('returns nothing for an empty folder', async () => {
    expect(await entriesFromDirectoryHandle(dir('empty', []))).toEqual([]);
  });
});

describe('picker selection', () => {
  it('is unsupported without showDirectoryPicker (jsdom, Firefox, Safari)', () => {
    expect(supportsDirectoryPicker()).toBe(false);
  });

  it('is supported when showDirectoryPicker exists, and asks for read mode', async () => {
    const show = vi.fn(async () => dir('rec', [file('0.avi')]));
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = show;
    expect(supportsDirectoryPicker()).toBe(true);
    const entries = await pickDirectory();
    expect(show).toHaveBeenCalledWith({ mode: 'read' });
    expect(entries?.map((e) => e.relPath)).toEqual(['rec/0.avi']);
  });

  it('resolves null when the user cancels', async () => {
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = async () => {
      throw new DOMException('cancelled', 'AbortError');
    };
    expect(await pickDirectory()).toBeNull();
  });

  it('propagates other errors', async () => {
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = async () => {
      throw new DOMException('blocked', 'SecurityError');
    };
    await expect(pickDirectory()).rejects.toThrow('blocked');
  });
});
