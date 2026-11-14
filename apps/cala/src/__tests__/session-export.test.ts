import { describe, expect, it } from 'vitest';
import {
  directoryResultsSink,
  ensureReadwrite,
  exportSessionBlock,
  runManifest,
  sessionMetadata,
  zipResultsSink,
  type SessionRecord,
  type WritableDirLike,
  type WritableFileLike,
} from '../lib/session-export.ts';
import { stageMeta } from '../lib/export.ts';
import type { StageRun } from '../lib/run-stages.ts';

const record = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  index: 1,
  name: 'My_V4_Miniscope',
  dir: 'Data/2026_11_10/14_02_33/My_V4_Miniscope',
  resultsPath: '2026_11_10/14_02_33/My_V4_Miniscope',
  startFrame: 100,
  frames: 50,
  fps: 30,
  recordingStartMs: Date.UTC(2026, 10, 10, 14, 2, 33),
  status: 'written',
  ...over,
});

const stage: StageRun = {
  stage: 'discover',
  index: 1,
  startedAt: '2026-11-10T14:00:00.000Z',
  endedAt: '2026-11-10T14:05:00.000Z',
  outcome: 'done',
  frames: 150,
  cells: 7,
  libraryVersion: 3,
  adds: 7,
};

const settings = { mode: 'joint', refineRuns: 2 } as const;

describe('sessionMetadata', () => {
  const base = {
    version: '2.14.0',
    settings,
    session: record(),
    sessions: 3,
    boundaries: [50, 100],
    stages: [stage],
    libraryVersion: 3,
    cells: 7,
    sharedCellIds: [4, 9] as number[] | null,
    createdAt: '2026-11-10T15:00:00.000Z',
  };

  it('uses snake_case keys and derived fields', () => {
    const m = sessionMetadata(base);
    expect(m).toMatchObject({
      format: 'cala-session',
      format_version: 1,
      app: 'cala',
      app_version: '2.14.0',
      created: base.createdAt,
      mode: 'joint',
      refine_runs: 2,
      session_index: 1,
      session_count: 3,
      session_name: 'My_V4_Miniscope',
      session_path: 'Data/2026_11_10/14_02_33/My_V4_Miniscope',
      recording_start: '2026-11-10T14:02:33.000Z',
      frames: 50,
      sampling_rate_hz: 30,
      frame_range_in_run: [100, 150],
      boundary_frames: [50, 100],
      library_version: 3,
      cells: 7,
      shared_cell_ids: [4, 9],
      export_file: 'cala-export.npz',
    });
    expect(m.stages_run).toEqual([stageMeta(stage)]);
    expect((m.stages_run as Record<string, unknown>[])[0]).toMatchObject({
      stage: 'discover',
      library_version: 3,
      adds: 7,
    });
  });

  it('null recording start and shared ids', () => {
    const m = sessionMetadata({
      ...base,
      session: record({ recordingStartMs: null, fps: null }),
      sharedCellIds: null,
    });
    expect(m.recording_start).toBeNull();
    expect(m.sampling_rate_hz).toBeNull();
    expect(m.shared_cell_ids).toBeNull();
  });

  it('copies boundaries', () => {
    const b = [5];
    const m = sessionMetadata({ ...base, boundaries: b });
    expect(m.boundary_frames).toEqual([5]);
    expect(m.boundary_frames).not.toBe(b);
  });
});

describe('exportSessionBlock', () => {
  it('describes the session', () => {
    expect(exportSessionBlock(record(), 'separate', 3)).toEqual({
      mode: 'separate',
      index: 1,
      count: 3,
      name: 'My_V4_Miniscope',
      path: 'Data/2026_11_10/14_02_33/My_V4_Miniscope',
      start_frame: 100,
      frames: 50,
    });
  });
});

describe('runManifest', () => {
  const base = {
    version: '2.14.0',
    settings,
    sessions: [
      record(),
      record({ index: 2, recordingStartMs: null, status: 'skipped', note: 'no cells were found' }),
    ],
    boundaries: [50],
    root: 'cala-results',
    createdAt: 'c',
    updatedAt: 'u',
    finished: false,
  };

  it('has snake_case keys and per-session entries', () => {
    const m = runManifest({ ...base, pipeline: { flat_field: true } });
    expect(m).toMatchObject({
      format: 'cala-run',
      app_version: '2.14.0',
      created: 'c',
      updated: 'u',
      finished: false,
      results_folder: 'cala-results',
      mode: 'joint',
      settings: { refine_runs: 2, flat_field: true },
      boundary_frames: [50],
    });
    const [a, b] = m.sessions as Record<string, unknown>[];
    expect(a).toMatchObject({
      index: 1,
      results_path: '2026_11_10/14_02_33/My_V4_Miniscope',
      start_frame: 100,
      sampling_rate_hz: 30,
      recording_start: '2026-11-10T14:02:33.000Z',
      status: 'written',
    });
    expect('note' in a).toBe(false);
    expect(b.recording_start).toBeNull();
    expect(b.note).toBe('no cells were found');
  });

  it('settings without pipeline holds only refine_runs', () => {
    expect(runManifest(base).settings).toEqual({ refine_runs: 2 });
  });
});

// ---- directory sink ----

class MockFile implements WritableFileLike {
  data: Uint8Array = new Uint8Array(0);
  aborted = false;
  closed = false;
  async createWritable() {
    const chunks: Uint8Array[] = [];
    return {
      write: async (d: Uint8Array | string) => {
        chunks.push(typeof d === 'string' ? new TextEncoder().encode(d) : d);
      },
      close: async () => {
        this.closed = true;
        const n = chunks.reduce((s, c) => s + c.length, 0);
        const out = new Uint8Array(n);
        let o = 0;
        for (const c of chunks) {
          out.set(c, o);
          o += c.length;
        }
        this.data = out;
      },
      abort: async () => {
        this.aborted = true;
      },
    };
  }
}

class MockDir implements WritableDirLike {
  dirs = new Map<string, MockDir>();
  files = new Map<string, MockFile>();
  constructor(readonly name: string) {}
  async *keys() {
    yield* this.dirs.keys();
    yield* this.files.keys();
  }
  async getDirectoryHandle(name: string, o?: { create?: boolean }) {
    let d = this.dirs.get(name);
    if (!d) {
      if (!o?.create) throw new Error('NotFound');
      d = new MockDir(name);
      this.dirs.set(name, d);
    }
    return d;
  }
  async getFileHandle(name: string, o?: { create?: boolean }) {
    let f = this.files.get(name);
    if (!f) {
      if (!o?.create) throw new Error('NotFound');
      f = new MockFile();
      this.files.set(name, f);
    }
    return f;
  }
}

describe('directoryResultsSink', () => {
  const now = new Date(2026, 10, 12, 9, 5, 7);

  it('uses cala-results when absent', async () => {
    const loc = new MockDir('data');
    const sink = await directoryResultsSink(loc, now);
    expect(sink.root).toBe('cala-results');
    expect(sink.method).toBe('directory');
    expect(loc.dirs.has('cala-results')).toBe(true);
  });

  it('timestamps the run folder when cala-results exists', async () => {
    const loc = new MockDir('data');
    await loc.getDirectoryHandle('cala-results', { create: true });
    const sink = await directoryResultsSink(loc, now);
    expect(sink.root).toBe('cala-results_2026-11-12_09-05-07');
    expect(loc.dirs.has('cala-results_2026-11-12_09-05-07')).toBe(true);
    // the old folder is untouched
    expect([...loc.dirs.get('cala-results')!.files.keys()]).toEqual([]);
  });

  it('writes nested paths, bytes and text', async () => {
    const loc = new MockDir('data');
    const sink = await directoryResultsSink(loc, now);
    const path = '2026_11_10/14_02_33/My_V4_Miniscope/cala-session.json';
    await sink.writeText(path, '{"a":1}');
    await sink.writeFile('2026_11_10/cala-export.npz', async (s) => {
      await s.write(Uint8Array.of(1, 2));
      await s.write(Uint8Array.of(3));
    });
    await sink.finish();
    const run = loc.dirs.get('cala-results')!;
    const leaf = run.dirs.get('2026_11_10')!.dirs.get('14_02_33')!.dirs.get('My_V4_Miniscope')!;
    expect(new TextDecoder().decode(leaf.files.get('cala-session.json')!.data)).toBe('{"a":1}');
    const npz = run.dirs.get('2026_11_10')!.files.get('cala-export.npz')!;
    expect([...npz.data]).toEqual([1, 2, 3]);
    expect(npz.closed).toBe(true);
  });

  it('aborts and rejects when the write callback throws', async () => {
    const loc = new MockDir('data');
    const sink = await directoryResultsSink(loc, now);
    await expect(
      sink.writeFile('a/b.bin', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const f = loc.dirs.get('cala-results')!.dirs.get('a')!.files.get('b.bin')!;
    expect(f.aborted).toBe(true);
    expect(f.closed).toBe(false);
  });

  it('rejects bad paths', async () => {
    const loc = new MockDir('data');
    const sink = await directoryResultsSink(loc, now);
    await expect(sink.writeText('../escape.txt', 'x')).rejects.toThrow(/Not a results path/);
    await expect(sink.writeText('a/../b.txt', 'x')).rejects.toThrow(/Not a results path/);
    await expect(sink.writeText('', 'x')).rejects.toThrow(/Not a results path/);
  });
});

// ---- zip sink ----

/** Entries of a stored zip, read from its central directory. */
function readZip(buf: ArrayBuffer): Map<string, Uint8Array> {
  const u8 = new Uint8Array(buf);
  const v = new DataView(buf);
  let eocd = u8.length - 22;
  while (v.getUint32(eocd, true) !== 0x06054b50) eocd--;
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    expect(v.getUint32(p, true)).toBe(0x02014b50);
    expect(v.getUint16(p + 10, true)).toBe(0); // stored
    const size = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen));
    const dataStart = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    out.set(name, u8.slice(dataStart, dataStart + size));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

describe('zipResultsSink', () => {
  it('delivers cala-results.zip with the tree under cala-results/', async () => {
    let got: { name: string; blob: Blob } | null = null;
    const sink = zipResultsSink((name, blob) => {
      got = { name, blob };
    });
    expect(sink.root).toBe('cala-results');
    expect(sink.method).toBe('zip');
    await sink.writeText('cala-run.json', 'first');
    await sink.writeText('cala-run.json', 'second');
    await sink.writeFile('s1/cala-export.npz', async (s) => {
      await s.write(Uint8Array.of(9, 8));
      await s.write(Uint8Array.of(7));
    });
    await sink.writeText('/s1//cala-session.json', '{}');
    expect(got).toBeNull();
    await sink.finish();
    expect(got).not.toBeNull();
    const { name, blob } = got as unknown as { name: string; blob: Blob };
    expect(name).toBe('cala-results.zip');
    expect(blob.type).toBe('application/zip');
    const entries = readZip(await blob.arrayBuffer());
    expect([...entries.keys()].sort()).toEqual([
      'cala-results/cala-run.json',
      'cala-results/s1/cala-export.npz',
      'cala-results/s1/cala-session.json',
    ]);
    expect(new TextDecoder().decode(entries.get('cala-results/cala-run.json')!)).toBe('second');
    expect([...entries.get('cala-results/s1/cala-export.npz')!]).toEqual([9, 8, 7]);
    expect(new TextDecoder().decode(entries.get('cala-results/s1/cala-session.json')!)).toBe('{}');
  });

  it('lets go of the files once the zip is delivered', async () => {
    const blobs: Blob[] = [];
    const sink = zipResultsSink((_, blob) => blobs.push(blob));
    await sink.writeFile('s1/cala-export.npz', (s) => s.write(new Uint8Array(1000)));
    await sink.finish();
    await sink.finish();
    expect(readZip(await blobs[0].arrayBuffer()).size).toBe(1);
    expect(readZip(await blobs[1].arrayBuffer()).size).toBe(0);
  });

  it('rejects bad paths', async () => {
    const sink = zipResultsSink(() => {});
    await expect(sink.writeText('../x', 'y')).rejects.toThrow(/Not a results path/);
  });
});

describe('ensureReadwrite', () => {
  it('is true without requestPermission', async () => {
    expect(await ensureReadwrite({})).toBe(true);
  });
  it('is true when already granted, without a request', async () => {
    let requested = false;
    const h = {
      queryPermission: async () => 'granted',
      requestPermission: async () => {
        requested = true;
        return 'denied';
      },
    };
    expect(await ensureReadwrite(h)).toBe(true);
    expect(requested).toBe(false);
  });
  it('requests when not granted', async () => {
    const mk = (r: string) => ({
      queryPermission: async () => 'prompt',
      requestPermission: async () => r,
    });
    expect(await ensureReadwrite(mk('granted'))).toBe(true);
    expect(await ensureReadwrite(mk('denied'))).toBe(false);
  });
  it('requests when there is no queryPermission', async () => {
    expect(await ensureReadwrite({ requestPermission: async () => 'denied' })).toBe(false);
  });
});
