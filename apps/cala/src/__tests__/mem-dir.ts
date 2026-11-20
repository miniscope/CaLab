import type { WritableDirLike } from '../lib/session-export.ts';

/** A folder in memory: writable (session-export's slice) and walkable (project-io's). */
export class MemDir implements WritableDirLike {
  readonly kind = 'directory' as const;
  dirs = new Map<string, MemDir>();
  files = new Map<string, string>();
  writes: string[] = [];
  constructor(readonly name: string) {}
  async *keys() {
    yield* this.dirs.keys();
    yield* this.files.keys();
  }
  async *values() {
    for (const d of this.dirs.values()) yield d;
    for (const [name, text] of this.files)
      yield { kind: 'file' as const, name, getFile: async () => new File([text], name) };
  }
  async getDirectoryHandle(name: string, o?: { create?: boolean }) {
    let d = this.dirs.get(name);
    if (!d) {
      if (!o?.create) throw new DOMException('not found', 'NotFoundError');
      d = new MemDir(name);
      this.dirs.set(name, d);
    }
    return d;
  }
  async getFileHandle(name: string, o?: { create?: boolean }) {
    if (!this.files.has(name) && !o?.create) throw new DOMException('not found', 'NotFoundError');
    return {
      createWritable: async () => {
        let buf = '';
        return {
          write: async (d: Uint8Array | string) => {
            buf += typeof d === 'string' ? d : new TextDecoder().decode(d);
          },
          close: async () => {
            this.files.set(name, buf);
            this.writes.push(name);
          },
        };
      },
    };
  }
  /** Make `a/b/c.json` with text. */
  async put(path: string, text: string): Promise<void> {
    const parts = path.split('/');
    const dir = await parts
      .slice(0, -1)
      .reduce<Promise<MemDir>>(
        async (d, p) => (await d).getDirectoryHandle(p, { create: true }),
        Promise.resolve(this),
      );
    dir.files.set(parts[parts.length - 1], text);
  }
}
