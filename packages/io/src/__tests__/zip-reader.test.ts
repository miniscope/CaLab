import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { ZipStreamWriter, type ByteSink } from '../zip-stream.ts';
import { ZipArchive } from '../zip-reader.ts';
import { parseNpy, parseNpyHeader } from '../npy-parser.ts';
import { writeNpy, writeNpyHeader } from '../npy-writer.ts';

function sink(): ByteSink & { blob(): Blob } {
  const parts: Uint8Array[] = [];
  return {
    write(c) {
      parts.push(c.slice());
    },
    blob: () => new Blob(parts as BlobPart[]),
  };
}

async function archive(forceZip64: boolean): Promise<Blob> {
  const s = sink();
  const zip = new ZipStreamWriter(s, { forceZip64 });
  await zip.addFile('a.npy', new Uint8Array(writeNpy(Float32Array.of(1, 2, 3), [3])));
  const body = new Float32Array(1000).map((_, i) => i);
  const bytes = new Uint8Array(body.buffer);
  async function* chunks() {
    yield bytes.subarray(0, 1500);
    yield bytes.subarray(1500);
  }
  await zip.addStream('big.bin', bytes.length, chunks());
  await zip.addFile('b.txt', new TextEncoder().encode('hello'));
  await zip.finish();
  return s.blob();
}

describe('ZipArchive', () => {
  for (const forceZip64 of [false, true]) {
    it(`reads entries lazily (${forceZip64 ? 'ZIP64' : 'classic'})`, async () => {
      const z = await ZipArchive.open(await archive(forceZip64));
      expect(z.entries.map((e) => e.name)).toEqual(['a.npy', 'big.bin', 'b.txt']);
      expect(z.entry('big.bin').size).toBe(4000);
      const a = parseNpy((await z.read('a.npy')).slice().buffer);
      expect(Array.from(a.data)).toEqual([1, 2, 3]);
      const part = await z.readRange('big.bin', 400, 412);
      expect(Array.from(new Float32Array(part.slice().buffer))).toEqual([100, 101, 102]);
      expect(new TextDecoder().decode(await z.read('b.txt'))).toBe('hello');
      expect(z.has('missing')).toBe(false);
      await expect(z.readRange('big.bin', 0, 5000)).rejects.toThrow(RangeError);
    });
  }

  it('reads deflated entries (np.savez_compressed)', async () => {
    const npy = new Uint8Array(writeNpy(new Float32Array(500).fill(7), [500]));
    const blob = new Blob([zipSync({ 'x.npy': [npy, { level: 6 }] }) as BlobPart]);
    const z = await ZipArchive.open(blob);
    expect(z.entry('x.npy').method).toBe(8);
    const x = parseNpy((await z.read('x.npy')).slice().buffer);
    expect(x.shape).toEqual([500]);
    expect(x.data[499]).toBe(7);
    expect(Array.from(await z.readRange('x.npy', 0, 6))).toEqual(Array.from(npy.subarray(0, 6)));
  });

  it('rejects a file that is not a ZIP archive', async () => {
    await expect(ZipArchive.open(new Blob([new Uint8Array(100)]))).rejects.toThrow(/Not a ZIP/);
  });
});

describe('parseNpyHeader', () => {
  it('locates the data of a Fortran-order array', () => {
    const head = writeNpyHeader('<f4', [2, 3], true);
    const bytes = new Uint8Array(head.length + 24);
    bytes.set(head);
    const h = parseNpyHeader(bytes.subarray(0, 200));
    expect(h).toMatchObject({ dtype: '<f4', shape: [2, 3], count: 6, fortranOrder: true });
    expect(h.itemBytes).toBe(4);
    expect(bytes.length - h.dataOffset).toBe(24);
  });
});
