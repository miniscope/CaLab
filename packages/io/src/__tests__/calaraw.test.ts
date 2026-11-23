import { describe, expect, it } from 'vitest';
import {
  CALARAW_HEADER_BYTES,
  CalarawError,
  calarawChunkName,
  calarawFramesPerChunk,
  decodeCalarawChunk,
  encodeCalaraw,
  encodeCalarawChunk,
  parseCalarawHeader,
  writeCalarawHeader,
  type CalarawFrame,
  type CalarawHeader,
  type CalarawMeta,
} from '../calaraw.ts';

const meta = (over: Partial<CalarawMeta> = {}): CalarawMeta => ({
  width: 5,
  height: 4,
  totalFrames: 7,
  bytesPerPixel: 2,
  predictor: 1,
  fps: 20,
  ...over,
});

/** Same pattern as python/tests/test_calaraw.py: hits the wrap of both bit depths. */
function pattern(m: CalarawMeta, t: number): CalarawFrame {
  const mask = m.bytesPerPixel === 1 ? 0xff : 0xffff;
  const f =
    m.bytesPerPixel === 1
      ? new Uint8Array(m.width * m.height)
      : new Uint16Array(m.width * m.height);
  for (let y = 0; y < m.height; y++) {
    for (let x = 0; x < m.width; x++) f[y * m.width + x] = (t * 40503 + y * 9973 + x * 7919) & mask;
  }
  return f;
}

const frames = (m: CalarawMeta, n = m.totalFrames): CalarawFrame[] =>
  Array.from({ length: n }, (_, t) => pattern(m, t));

async function gzipRaw(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const s = new Blob([data]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

async function collect(m: CalarawMeta, input: CalarawFrame[], chunkBytes?: number) {
  const out = [];
  for await (const c of encodeCalaraw(m, input, chunkBytes)) out.push(c);
  return out;
}

describe('calaraw header', () => {
  const h: CalarawHeader = { ...meta(), firstFrame: 2, frames: 3 };

  it('round-trips', () => {
    const b = writeCalarawHeader(h);
    expect(b.length).toBe(CALARAW_HEADER_BYTES);
    expect(parseCalarawHeader(b)).toEqual(h);
  });

  it.each([
    ['bad magic', (b: Uint8Array) => (b[0] = 0x58)],
    ['reserved bytes', (b: Uint8Array) => (b[30] = 1)],
    ['bytes per pixel', (b: Uint8Array) => (b[28] = 3)],
    ['predictor', (b: Uint8Array) => (b[29] = 2)],
    ['zero width', (b: Uint8Array) => b.fill(0, 8, 12)],
    ['frames past total', (b: Uint8Array) => (b[20] = 9)],
    ['nan fps', (b: Uint8Array) => new DataView(b.buffer).setFloat64(32, NaN, true)],
  ])('rejects %s', (_, corrupt) => {
    const b = writeCalarawHeader(h);
    corrupt(b);
    expect(() => parseCalarawHeader(b)).toThrow(CalarawError);
  });

  it('rejects a truncated header', () => {
    expect(() => parseCalarawHeader(writeCalarawHeader(h).subarray(0, 39))).toThrow(CalarawError);
  });
});

describe('calaraw round trip', () => {
  it.each([
    ['uint16, up', meta()],
    ['uint16, none', meta({ predictor: 0 })],
    ['uint8, up', meta({ bytesPerPixel: 1 })],
    ['uint8, none', meta({ bytesPerPixel: 1, predictor: 0 })],
    ['one row', meta({ height: 1 })],
  ])('%s', async (_, m) => {
    const input = frames(m);
    // Two frames per chunk: chunks of 2, 2, 2, 1.
    const chunks = await collect(m, input, 2 * m.width * m.height * m.bytesPerPixel);
    expect(chunks.map((c) => [c.index, c.firstFrame, c.frames])).toEqual([
      [0, 0, 2],
      [1, 2, 2],
      [2, 4, 2],
      [3, 6, 1],
    ]);
    const out: CalarawFrame[] = [];
    for (const c of chunks) {
      const { header, frames: f } = await decodeCalarawChunk(c.bytes as Uint8Array<ArrayBuffer>);
      expect(header).toEqual({ ...m, firstFrame: c.firstFrame, frames: c.frames });
      out.push(...f);
    }
    expect(out).toEqual(input);
  });

  it('accepts an async frame source', async () => {
    const m = meta();
    async function* source() {
      for (const f of frames(m)) yield f;
    }
    const chunks = [];
    for await (const c of encodeCalaraw(m, source())) chunks.push(c);
    expect(chunks).toHaveLength(1);
    expect((await decodeCalarawChunk(chunks[0].bytes as Uint8Array<ArrayBuffer>)).frames).toEqual(
      frames(m),
    );
  });

  it('shrinks smooth frames with the up predictor', async () => {
    // A vertical ramp: rows differ by a constant, so residuals are all the same.
    const m = meta({ width: 256, height: 256, totalFrames: 1, bytesPerPixel: 1 });
    const f = new Uint8Array(256 * 256).map((_, i) => (i >> 8) * 3 + (i & 255));
    const up = await encodeCalarawChunk(m, 0, [f]);
    const none = await encodeCalarawChunk({ ...m, predictor: 0 }, 0, [f]);
    expect(up.length).toBeLessThan(none.length);
  });
});

describe('calaraw encoder checks', () => {
  it('needs exactly totalFrames frames', async () => {
    const m = meta();
    await expect(collect(m, frames(m, 6))).rejects.toThrow(/got 6 frames/);
    await expect(collect(m, frames(m, 8))).rejects.toThrow(/more than 7/);
  });

  it('rejects frames of the wrong type or size', async () => {
    const m = meta();
    await expect(collect(m, [new Uint8Array(20)])).rejects.toThrow(/not a Uint16Array/);
    await expect(collect(m, [new Uint16Array(19)])).rejects.toThrow(/19 pixels/);
  });

  it('rejects bad metadata', async () => {
    await expect(collect(meta({ fps: 0 }), [])).rejects.toThrow(CalarawError);
    await expect(collect(meta({ width: 0 }), [])).rejects.toThrow(CalarawError);
  });

  it('keeps at least one frame per chunk', () => {
    expect(calarawFramesPerChunk(meta(), 1)).toBe(1);
    expect(calarawFramesPerChunk(meta(), 400)).toBe(10);
  });

  it('names chunks in order', () => {
    expect(calarawChunkName(7)).toBe('frames-0007.calaraw.gz');
  });
});

describe('calaraw decoder checks', () => {
  const m = meta();
  const fb = m.width * m.height * 2;
  const raw = (frames: number, payload: number) => {
    const b = new Uint8Array(CALARAW_HEADER_BYTES + payload);
    b.set(writeCalarawHeader({ ...m, firstFrame: 0, frames }));
    return b;
  };

  it('rejects a truncated payload', async () => {
    const gz = await gzipRaw(raw(2, fb));
    await expect(decodeCalarawChunk(gz)).rejects.toThrow(/header says/);
  });

  it('rejects trailing bytes', async () => {
    const gz = await gzipRaw(raw(1, fb + 1));
    await expect(decodeCalarawChunk(gz)).rejects.toThrow(/header says/);
  });

  it('stops inflating past the size cap', async () => {
    const gz = await gzipRaw(raw(7, 7 * fb));
    await expect(decodeCalarawChunk(gz, 3 * fb)).rejects.toThrow(/inflates past/);
  });

  it('rejects data that is not gzip', async () => {
    await expect(decodeCalarawChunk(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow(CalarawError);
  });
});
