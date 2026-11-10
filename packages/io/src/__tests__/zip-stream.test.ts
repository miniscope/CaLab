import { describe, it, expect } from 'vitest';
import { unzipSync } from 'fflate';
import { ZipStreamWriter, crc32, type ByteSink } from '../zip-stream.ts';
import { writeNpyHeader, writeNpy } from '../npy-writer.ts';
import { parseNpy } from '../npy-parser.ts';

class Collect implements ByteSink {
  parts: Uint8Array[] = [];
  write(chunk: Uint8Array): void {
    this.parts.push(chunk);
  }
  bytes(): Uint8Array {
    const n = this.parts.reduce((a, p) => a + p.length, 0);
    const out = new Uint8Array(n);
    let at = 0;
    for (const p of this.parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
}

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
  it('is incremental and handles any alignment', () => {
    const data = new Uint8Array(1003).map((_, i) => (i * 31 + 7) & 0xff);
    const whole = crc32(data);
    for (const cut of [0, 1, 7, 8, 9, 500, 1002, 1003]) {
      expect(crc32(data.subarray(cut), crc32(data.subarray(0, cut)))).toBe(whole);
    }
  });
});

describe('writeNpyHeader', () => {
  it('writes a Fortran-order header that parseNpy reads', () => {
    const header = writeNpyHeader('<f4', [2, 3], true);
    expect(header.length % 64).toBe(0);
    // Fortran order: (2 x 3) array stored column after column.
    const data = Float32Array.of(1, 4, 2, 5, 3, 6); // [[1,2,3],[4,5,6]]
    const buf = new Uint8Array(header.length + data.byteLength);
    buf.set(header);
    buf.set(new Uint8Array(data.buffer), header.length);
    const r = parseNpy(buf.buffer);
    expect(r.fortranOrder).toBe(true);
    expect(r.shape).toEqual([2, 3]);
  });
  it('matches writeNpy for C order', () => {
    const d = Float32Array.of(1, 2, 3);
    expect(new Uint8Array(writeNpy(d, [3])).subarray(0, 64)).toEqual(
      writeNpyHeader('<f4', [3]).subarray(0, 64),
    );
  });
});

describe('ZipStreamWriter', () => {
  it('writes entries fflate reads back (small, no ZIP64)', async () => {
    const sink = new Collect();
    const z = new ZipStreamWriter(sink);
    const a = new TextEncoder().encode('hello');
    const b = Uint8Array.from({ length: 5000 }, (_, i) => i & 0xff);
    await z.addFile('a.txt', a);
    await z.addStream('b.bin', b.length, [b.subarray(0, 1234), b.subarray(1234)]);
    await z.addFile('empty.bin', new Uint8Array(0));
    await z.finish();
    const out = unzipSync(sink.bytes());
    expect(Object.keys(out).sort()).toEqual(['a.txt', 'b.bin', 'empty.bin']);
    expect(out['a.txt']).toEqual(a);
    expect(out['b.bin']).toEqual(b);
    expect(out['empty.bin'].length).toBe(0);
  });

  it('writes ZIP64 records when forced, and fflate reads them', async () => {
    const sink = new Collect();
    const z = new ZipStreamWriter(sink, { forceZip64: true });
    const b = Uint8Array.from({ length: 777 }, (_, i) => (i * 3) & 0xff);
    await z.addFile('x.npy', b);
    await z.addStream('y.npy', b.length, [b]);
    await z.finish();
    const bytes = sink.bytes();
    // ZIP64 end-of-central-directory record and locator are present.
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(bytes.length - 22 - 20, true)).toBe(0x07064b50);
    const out = unzipSync(bytes);
    expect(out['x.npy']).toEqual(b);
    expect(out['y.npy']).toEqual(b);
  });

  it('rejects a stream whose length differs from the declared size', async () => {
    const z = new ZipStreamWriter(new Collect());
    await expect(z.addStream('s', 10, [new Uint8Array(9)])).rejects.toThrow(/declared/);
    const z2 = new ZipStreamWriter(new Collect());
    await expect(z2.addStream('s', 10, [new Uint8Array(11)])).rejects.toThrow(/declared/);
  });

  it('records offsets past 4 GiB in the central directory (logical test)', async () => {
    // A sink that only counts bytes: write a 4.5 GiB stored entry as zeros.
    let total = 0;
    const tail: Uint8Array[] = [];
    const sink: ByteSink = {
      write(chunk) {
        total += chunk.length;
        tail.push(chunk);
        if (tail.length > 8) tail.shift();
      },
    };
    const z = new ZipStreamWriter(sink);
    const chunk = new Uint8Array(64 * 1024 * 1024);
    const size = 4.5 * 2 ** 30;
    await z.addStream(
      'big.npy',
      size,
      (function* () {
        for (let left = size; left > 0; left -= chunk.length) {
          yield left >= chunk.length ? chunk : chunk.subarray(0, left);
        }
      })(),
    );
    await z.addFile('after.npy', Uint8Array.of(1, 2, 3));
    await z.finish();
    expect(z.bytesWritten).toBe(total);
    expect(total).toBeGreaterThan(size);
    // The central directory starts past 4 GiB, so the end record points to the
    // ZIP64 record (which carries the real count and offset).
    const eocd = tail[tail.length - 1];
    const e = new DataView(eocd.buffer, eocd.byteOffset, eocd.byteLength);
    expect(e.getUint32(0, true)).toBe(0x06054b50);
    expect(e.getUint16(10, true)).toBe(0xffff);
    const rec = tail[tail.length - 2];
    const r = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
    expect(r.getUint32(0, true)).toBe(0x06064b50);
    expect(r.getUint32(24, true)).toBe(2);
    expect(r.getUint32(48, true) + r.getUint32(52, true) * 2 ** 32).toBeGreaterThan(size);
  }, 60_000);
});
