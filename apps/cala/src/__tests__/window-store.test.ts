// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { OpfsWriterClient } from '../lib/opfs-writer.ts';
import { isPinned, openFactorReader, opfsStore, pinned } from '../lib/window-store.ts';

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

describe("opfsStore's sweep of other runs' folders", () => {
  /**
   * Web Locks as the store uses them: a lock is held until its callback's
   * promise settles; `ifAvailable` gets null when the name is held.
   */
  function fakeLocks(events: string[] = []) {
    const held = new Set<string>();
    type Cb = (lock: { name: string } | null) => Promise<unknown> | unknown;
    const locks = {
      held,
      request(name: string, a: { ifAvailable?: boolean } | Cb, b?: Cb): Promise<unknown> {
        const cb = (typeof a === 'function' ? a : b)!;
        const ifAvailable = typeof a === 'object' && a.ifAvailable === true;
        if (held.has(name)) {
          if (ifAvailable) return Promise.resolve(cb(null));
          return new Promise(() => {}); // queued behind the holder (not needed here)
        }
        held.add(name);
        events.push(`lock ${name}`);
        return Promise.resolve(cb({ name })).finally(() => held.delete(name));
      },
    };
    return locks;
  }

  /** An OPFS root holding the run folders `names` under `cala-compress`. */
  function fakeOpfs(names: string[], events: string[] = []) {
    const folders = new Set(names);
    const run = {
      getFileHandle: async () => ({}),
      removeEntry: async () => {},
      keys: async function* () {},
    };
    const root = {
      getDirectoryHandle: async (name: string) => {
        events.push(`create ${name}`);
        folders.add(name);
        return run;
      },
      removeEntry: async (name: string) => {
        events.push(`remove ${name}`);
        folders.delete(name);
      },
      keys: async function* () {
        yield* [...folders];
      },
    };
    const top = { getDirectoryHandle: async () => root };
    return { folders, top };
  }

  it('leaves a folder whose owner holds its lock, and removes one whose lock is free', async () => {
    const locks = fakeLocks();
    // Another tab's compress worker owns run-live.
    void locks.request('cala-compress/run-live', () => new Promise(() => {}));
    const { folders, top } = fakeOpfs(['run-live', 'run-dead']);
    const store = opfsStore('run-mine', async () => top, locks);
    await store.remove('nothing');
    expect([...folders].sort()).toEqual(['run-live', 'run-mine']);
  });

  it('removes every other folder as before where Web Locks do not exist', async () => {
    const { folders, top } = fakeOpfs(['run-a', 'run-b']);
    const store = opfsStore('run-mine', async () => top, null);
    await store.remove('nothing');
    expect([...folders]).toEqual(['run-mine']);
  });

  it('holds the lock of its own folder from before the folder exists, for its lifetime', async () => {
    const events: string[] = [];
    const locks = fakeLocks(events);
    const { top } = fakeOpfs([], events);
    const store = opfsStore('run-mine', async () => top, locks);
    await store.remove('nothing');
    expect(events.indexOf('lock cala-compress/run-mine')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('lock cala-compress/run-mine')).toBeLessThan(
      events.indexOf('create run-mine'),
    );
    await tick();
    expect(locks.held.has('cala-compress/run-mine')).toBe(true);
    // A second tab's sweep finds it owned and leaves it.
    const other = fakeOpfs(['run-mine']);
    await opfsStore('run-other', async () => other.top, locks).remove('nothing');
    expect(other.folders.has('run-mine')).toBe(true);
  });
});

describe("the trace files' sweep", () => {
  it("never removes the compression's folder (its run folders have their own locks)", async () => {
    const sent: { op: string; keep?: string[] }[] = [];
    const worker = {
      onmessage: null as ((e: { data: unknown }) => void) | null,
      onerror: null,
      postMessage(msg: { id: number; op: string; keep?: string[] }) {
        sent.push(msg);
        setTimeout(() => worker.onmessage?.({ data: { id: msg.id, ok: true, count: 0 } }), 0);
      },
    };
    const client = new OpfsWriterClient(worker as unknown as Worker);
    await client.sweep(['cala-pass2-a.bin']);
    expect(sent[0].op).toBe('sweep');
    expect(sent[0].keep).toEqual(expect.arrayContaining(['cala-pass2-a.bin', 'cala-compress']));
  });
});

describe('openFactorReader (a reader that does not own the folder)', () => {
  /** An OPFS root with `cala-compress/run-a` holding `files`; every call is recorded. */
  function fakeRoot(files: Record<string, Uint8Array>, calls: string[]) {
    const closed: string[] = [];
    const opening = new Set<object>();
    const run = {
      getFileHandle: async (name: string, o?: { create?: boolean }) => {
        calls.push(`file ${name}${o?.create ? ' create' : ''}`);
        const data = files[name];
        if (!data) throw new Error(`${name} not found`);
        const file = {
          createSyncAccessHandle: async () => {
            opening.add(file);
            await tick();
            return {
              write: () => 0,
              read: (into: Uint8Array, { at }: { at: number }) => {
                const part = data.subarray(at, at + into.length);
                into.set(part);
                return part.length;
              },
              getSize: () => data.length,
              flush: () => {},
              close: () => closed.push(name),
            };
          },
        };
        return file;
      },
      removeEntry: async (name: string) => void calls.push(`remove ${name}`),
      keys: async function* () {
        calls.push('keys');
        yield* Object.keys(files);
      },
    };
    const root = {
      getDirectoryHandle: async (name: string, o?: { create?: boolean }) => {
        calls.push(`dir ${name}${o?.create ? ' create' : ''}`);
        if (name !== 'run-a') throw new Error(`${name} not found`);
        return run;
      },
      removeEntry: async (name: string) => void calls.push(`remove ${name}`),
      keys: async function* () {
        calls.push('keys');
        yield 'run-a';
      },
    };
    const top = {
      getDirectoryHandle: async (name: string, o?: { create?: boolean }) => {
        calls.push(`root ${name}${o?.create ? ' create' : ''}`);
        return root;
      },
    };
    return { top: async () => top, closed, opening };
  }

  it('reads whole factor files from the folder, never creating, listing or removing anything', async () => {
    const calls: string[] = [];
    const f = fakeRoot({ 'f0.bin': Uint8Array.of(1, 2, 3), 'f1.bin': Uint8Array.of(4, 5) }, calls);
    const reader = await openFactorReader('run-a', ['f0.bin', 'f1.bin'], f.top);
    expect(reader.windows).toBe(2);
    expect([...reader.read(1)]).toEqual([4, 5]);
    expect([...reader.read(0)]).toEqual([1, 2, 3]);
    expect(() => reader.read(2)).toThrow('No factor window 2.');
    reader.close();
    reader.close();
    expect(f.closed).toEqual(['f0.bin', 'f1.bin']);
    expect(() => reader.read(0)).toThrow('No factor window 0.');
    expect(calls).toEqual(['root cala-compress', 'dir run-a', 'file f0.bin', 'file f1.bin']);
  });

  it('keeps each file handle referenced while its access handle opens', async () => {
    const calls: string[] = [];
    const f = fakeRoot({ 'f0.bin': Uint8Array.of(1) }, calls);
    const opened = openFactorReader('run-a', ['f0.bin'], f.top);
    for (let i = 0; i < 10 && f.opening.size === 0; i++) await tick();
    const [file] = [...f.opening];
    expect(isPinned(file)).toBe(true);
    (await opened).close();
    expect(isPinned(file)).toBe(false);
  });

  it('closes what it opened when a file or the folder is missing, and says so', async () => {
    const calls: string[] = [];
    const f = fakeRoot({ 'f0.bin': Uint8Array.of(1) }, calls);
    await expect(openFactorReader('run-a', ['f0.bin', 'f1.bin'], f.top)).rejects.toThrow(
      /^The factor files of this run cannot be opened: f1.bin not found/,
    );
    expect(f.closed).toEqual(['f0.bin']);
    await expect(openFactorReader('run-gone', ['f0.bin'], f.top)).rejects.toThrow(
      /^The factor files of this run cannot be opened: run-gone not found/,
    );
    expect(calls.some((c) => c.includes('create') || c.startsWith('remove') || c === 'keys')).toBe(
      false,
    );
  });
});
