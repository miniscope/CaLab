// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { isPinned, opfsStore, pinned } from '../lib/window-store.ts';

/** A promise settled from outside. */
function deferred<T>(): { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('pinned', () => {
  it('keeps the handle referenced until its call settles', async () => {
    const handle = {};
    const d = deferred<number>();
    const result = pinned(handle, () => d.promise);
    expect(isPinned(handle)).toBe(true);
    d.resolve(7);
    expect(await result).toBe(7);
    expect(isPinned(handle)).toBe(false);
  });

  it('releases the handle when the call fails, and passes the error on', async () => {
    const handle = {};
    const d = deferred<number>();
    const result = pinned(handle, () => d.promise);
    d.reject(new Error('no access'));
    await expect(result).rejects.toThrow('no access');
    expect(isPinned(handle)).toBe(false);
  });

  it('keeps a handle with two calls in flight until both settled', async () => {
    const handle = {};
    const a = deferred<void>();
    const b = deferred<void>();
    const first = pinned(handle, () => a.promise);
    const second = pinned(handle, () => b.promise);
    a.resolve();
    await first;
    expect(isPinned(handle)).toBe(true);
    b.resolve();
    await second;
    expect(isPinned(handle)).toBe(false);
  });
});

describe('opfsStore', () => {
  it('holds the file handle while its access handle is being opened', async () => {
    // Chrome never settles a pending createSyncAccessHandle() once its file
    // handle is garbage collected: the store must keep the handle reachable.
    const opening = deferred<unknown>();
    const file = { createSyncAccessHandle: () => opening.promise };
    const run = {
      getFileHandle: async () => file,
      removeEntry: async () => {},
      keys: async function* () {},
    };
    const root = {
      getDirectoryHandle: async () => run,
      removeEntry: async () => {},
      keys: async function* () {},
    };
    const top = { getDirectoryHandle: async () => root };
    const store = opfsStore('run-test', async () => top);
    const opened = store.open('w0.i16');
    for (let i = 0; i < 5 && !isPinned(file); i++) await tick();
    expect(isPinned(file)).toBe(true);
    const closed: string[] = [];
    opening.resolve({
      write: () => 0,
      read: () => 0,
      getSize: () => 3,
      flush: () => closed.push('flush'),
      close: () => closed.push('close'),
    });
    const f = await opened;
    expect(isPinned(file)).toBe(false);
    expect(f.size()).toBe(3);
    f.close();
    expect(closed).toEqual(['flush', 'close']);
  });
});
