import { describe, expect, it } from 'vitest';
import {
  exportSessionBlock,
  sinkInDirectory,
  zipResultsSink,
  type SessionRecord,
} from '../lib/session-export.ts';
import { MemDir } from './mem-dir.ts';

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

describe('sinkInDirectory', () => {
  it('writes nested paths, bytes and text', async () => {
    const loc = new MemDir('data');
    const sink = sinkInDirectory(loc, 'data/calab-project/runs/r1');
    const path = '2026_11_10/14_02_33/My_V4_Miniscope/calab-run.json';
    await sink.writeText(path, '{"a":1}');
    await sink.writeFile('2026_11_10/cala-export.npz', async (s) => {
      await s.write(Uint8Array.of(1, 2));
      await s.write(Uint8Array.of(3));
    });
    await sink.finish();
    const run = loc;
    const leaf = run.dirs.get('2026_11_10')!.dirs.get('14_02_33')!.dirs.get('My_V4_Miniscope')!;
    expect(leaf.files.get('calab-run.json')).toBe('{"a":1}');
    const dated = run.dirs.get('2026_11_10')!;
    const npz = dated.files.get('cala-export.npz')!;
    expect([...npz].map((c) => c.charCodeAt(0))).toEqual([1, 2, 3]);
    expect(dated.writes).toContain('cala-export.npz');
  });

  it('aborts and rejects when the write callback throws', async () => {
    const loc = new MemDir('data');
    const sink = sinkInDirectory(loc, 'data/calab-project/runs/r1');
    await expect(
      sink.writeFile('a/b.bin', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const dir = loc.dirs.get('a')!;
    expect(dir.aborts).toEqual(['b.bin']);
    expect(dir.writes).toEqual([]);
  });

  it('rejects bad paths', async () => {
    const loc = new MemDir('data');
    const sink = sinkInDirectory(loc, 'data/calab-project/runs/r1');
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
  it('delivers the run folder and the project files under calab-project/', async () => {
    let got: { name: string; blob: Blob } | null = null;
    const sink = zipResultsSink('runs/r1_cala', (name, blob) => {
      got = { name, blob };
    });
    expect(sink.root).toBe('calab-project/runs/r1_cala');
    expect(sink.method).toBe('zip');
    await sink.writeText('calab-run.json', 'first');
    await sink.writeText('calab-run.json', 'second');
    await sink.writeFile('s1/cala-export.npz', async (s) => {
      await s.write(Uint8Array.of(9, 8));
      await s.write(Uint8Array.of(7));
    });
    await sink.writeProjectText!('calab-project.json', '{}');
    expect(got).toBeNull();
    await sink.finish();
    expect(got).not.toBeNull();
    const { name, blob } = got as unknown as { name: string; blob: Blob };
    expect(name).toBe('calab-project_r1_cala.zip');
    expect(blob.type).toBe('application/zip');
    const entries = readZip(await blob.arrayBuffer());
    expect([...entries.keys()].sort()).toEqual([
      'calab-project/calab-project.json',
      'calab-project/runs/r1_cala/calab-run.json',
      'calab-project/runs/r1_cala/s1/cala-export.npz',
    ]);
    const text = (k: string) => new TextDecoder().decode(entries.get(k)!);
    expect(text('calab-project/runs/r1_cala/calab-run.json')).toBe('second');
    expect([...entries.get('calab-project/runs/r1_cala/s1/cala-export.npz')!]).toEqual([9, 8, 7]);
  });

  it('lets go of the files once the zip is delivered', async () => {
    const blobs: Blob[] = [];
    const sink = zipResultsSink('runs/r', (_, blob) => blobs.push(blob));
    await sink.writeFile('s1/cala-export.npz', async (s) => {
      await s.write(new Uint8Array(1000));
    });
    await sink.finish();
    await sink.finish();
    expect(readZip(await blobs[0].arrayBuffer()).size).toBe(1);
    expect(readZip(await blobs[1].arrayBuffer()).size).toBe(0);
  });

  it('rejects bad paths', async () => {
    const sink = zipResultsSink('runs/r', () => {});
    await expect(sink.writeText('../x', 'y')).rejects.toThrow(/Not a results path/);
  });
});
