// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { OpfsWriterClient } from '../lib/opfs-writer.ts';
import {
  COMPRESS_ROOT,
  factorFiles,
  isPinned,
  memoryStore,
  opfsStore,
  pinned,
} from '../lib/window-store.ts';

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

/** A fake OPFS directory tree that records every call. */
function fakeTree(files: Record<string, Uint8Array>) {
  const calls: string[] = [];
  const file = (name: string) => ({
    getFile: async () => {
      calls.push(`getFile ${name}`);
      const b = files[name];
      if (!b) throw new DOMException('missing', 'NotFoundError');
      return new Blob([b as BlobPart]);
    },
    createSyncAccessHandle: async () => {
      calls.push(`sah ${name}`);
      throw new Error('a reader never opens an access handle');
    },
  });
  const dir = (path: string): unknown => ({
    getDirectoryHandle: async (n: string, o?: { create?: boolean }) => {
      calls.push(`dir ${path}/${n}${o?.create ? ' create' : ''}`);
      return dir(`${path}/${n}`);
    },
    getFileHandle: async (n: string, o?: { create?: boolean }) => {
      calls.push(`file ${n}${o?.create ? ' create' : ''}`);
      return file(n);
    },
    removeEntry: async (n: string) => void calls.push(`remove ${n}`),
    keys: () => {
      calls.push(`keys ${path}`);
      return (async function* () {})();
    },
  });
  return { top: async () => dir(''), calls };
}

describe('factorFiles', () => {
  it('reads a whole file through getFile and never creates, lists or removes', async () => {
    const t = fakeTree({ 'f0.bin': Uint8Array.of(1, 2, 3) });
    const r = factorFiles('run-a', t.top);
    expect([...(await r.read('f0.bin'))]).toEqual([1, 2, 3]);
    expect(t.calls).toEqual([
      `dir /${COMPRESS_ROOT}`,
      `dir /${COMPRESS_ROOT}/run-a`,
      'file f0.bin',
      'getFile f0.bin',
    ]);
    expect(t.calls.some((c) => /create|keys|remove|sah/.test(c))).toBe(false);
  });
  it('a missing file rejects with its name; the next read tries again', async () => {
    const t = fakeTree({});
    const r = factorFiles('run-a', t.top);
    await expect(r.read('f9.bin')).rejects.toThrow('f9.bin');
  });
});

describe('the store names its folder and reads whole files', () => {
  it('memory store', async () => {
    const s = memoryStore();
    const f = await s.open('f0.bin');
    f.write(Uint8Array.of(4, 5), 0);
    f.close();
    expect(s.folder).toBe('memory');
    expect([...(await s.readAll('f0.bin'))]).toEqual([4, 5]);
  });
});
