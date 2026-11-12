/**
 * Worker that writes files in the origin private file system through
 * synchronous access handles (see lib/opfs-writer.ts). One handle per open
 * file name; requests are answered in order.
 */
export type OpfsRequest =
  | { id: number; op: 'open'; name: string }
  | { id: number; op: 'write'; name: string; at: number; bytes: Uint8Array }
  | { id: number; op: 'close'; name: string }
  | { id: number; op: 'remove'; name: string }
  | { id: number; op: 'sweep'; prefix: string; keep: string[] }
  | { id: number; op: 'probe' };

export type OpfsResponse =
  | { id: number; ok: true; count?: number }
  | { id: number; ok: false; name: string; message: string };

interface SyncHandle {
  write(buffer: ArrayBufferView, options?: { at?: number }): number;
  flush(): void;
  close(): void;
  truncate(size: number): void;
}
type SyncFileHandle = FileSystemFileHandle & { createSyncAccessHandle(): Promise<SyncHandle> };

const handles = new Map<string, SyncHandle>();

async function root(): Promise<FileSystemDirectoryHandle> {
  return navigator.storage.getDirectory();
}

function closeHandle(name: string): void {
  const h = handles.get(name);
  if (!h) return;
  handles.delete(name);
  try {
    h.flush();
  } finally {
    h.close();
  }
}

async function handle(req: OpfsRequest): Promise<number | undefined> {
  switch (req.op) {
    case 'open': {
      closeHandle(req.name);
      const fh = (await (await root()).getFileHandle(req.name, { create: true })) as SyncFileHandle;
      const h = await fh.createSyncAccessHandle();
      h.truncate(0);
      handles.set(req.name, h);
      return;
    }
    case 'write': {
      const h = handles.get(req.name);
      if (!h) throw new Error(`${req.name} is not open.`);
      let done = 0;
      while (done < req.bytes.length) {
        const n = h.write(req.bytes.subarray(done), { at: req.at + done });
        if (n <= 0) throw new DOMException('Short write', 'QuotaExceededError');
        done += n;
      }
      return;
    }
    case 'close':
      closeHandle(req.name);
      return;
    case 'remove':
      closeHandle(req.name);
      try {
        await (await root()).removeEntry(req.name);
      } catch (err) {
        if (!(err instanceof DOMException && err.name === 'NotFoundError')) throw err;
      }
      return;
    case 'probe': {
      // Some browsers expose OPFS but cannot use it (private windows, ephemeral
      // storage): the failure only shows when a synchronous handle is opened.
      const name = 'cala-probe';
      const fh = (await (await root()).getFileHandle(name, { create: true })) as SyncFileHandle;
      const h = await fh.createSyncAccessHandle();
      h.write(new Uint8Array(8), { at: 0 });
      h.close();
      await (await root()).removeEntry(name);
      return;
    }
    case 'sweep': {
      const dir = await root();
      const names: string[] = [];
      for await (const key of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) {
        if (key.startsWith(req.prefix) && !req.keep.includes(key)) names.push(key);
      }
      let removed = 0;
      for (const name of names) {
        try {
          closeHandle(name);
          await dir.removeEntry(name);
          removed++;
        } catch {
          // held open by another tab: leave it
        }
      }
      return removed;
    }
  }
}

self.onmessage = (e: MessageEvent<OpfsRequest>) => {
  const req = e.data;
  handle(req).then(
    (count) => {
      const res: OpfsResponse = { id: req.id, ok: true, ...(count === undefined ? {} : { count }) };
      self.postMessage(res);
    },
    (err: unknown) => {
      const res: OpfsResponse = {
        id: req.id,
        ok: false,
        name: err instanceof Error ? err.name : 'Error',
        message: err instanceof Error ? err.message : String(err),
      };
      self.postMessage(res);
    },
  );
};
