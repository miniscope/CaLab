/**
 * Robustness tests for the binary parsers (.npy / .npz / .mat): every numpy
 * dtype the apps can plausibly receive, both byte orders, Fortran order,
 * zero-size and overflowing shapes, truncated and corrupt files, and the
 * decompressed-size cap that stops zip / zlib bombs.
 *
 * The happy-path fixture (`dtypes.npz`) is written by real numpy (see
 * __fixtures__/gen-npy-fixtures.py); hostile inputs are built byte-by-byte
 * here, because no well-behaved writer will produce them.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { zipSync, zlibSync } from 'fflate';
import { parseNpy } from '../npy-parser.ts';
import { parseNpz } from '../npz-parser.ts';
import { parseMat } from '../mat-parser.ts';
import { processNpyResult } from '../array-utils.ts';
import { DEFAULT_MAX_DECOMPRESSED_BYTES, DecompressedSizeLimitError } from '../size-limit.ts';

const MiB = 1024 * 1024;

// --- generic helpers ---

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** Deterministic PRNG (mulberry32) so fuzz failures are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Run `fn`; it may succeed or throw, but a throw must be a deliberate parser
 * error -- never a bare RangeError/TypeError from an unchecked offset.
 */
function expectCleanOutcome(fn: () => unknown, label: string): void {
  try {
    fn();
  } catch (err) {
    expect(err, label).toBeInstanceOf(Error);
    const e = err as Error;
    expect(['Error', 'DecompressedSizeLimitError'], `${label}: ${e.name}: ${e.message}`).toContain(
      e.name,
    );
  }
}

// --- .npy builder: arbitrary header dict + raw data bytes ---

function npyFromHeader(headerDict: string, data: Uint8Array = new Uint8Array(0), version = 1) {
  const preambleLen = version === 1 ? 10 : 12;
  const headerBytes = new TextEncoder().encode(headerDict);
  let headerLen = headerBytes.length + 1;
  const rem = (preambleLen + headerLen) % 64;
  if (rem !== 0) headerLen += 64 - rem;
  const out = new Uint8Array(preambleLen + headerLen + data.length);
  out.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, version, 0]);
  const dv = new DataView(out.buffer);
  if (version === 1) dv.setUint16(8, headerLen, true);
  else dv.setUint32(8, headerLen, true);
  out.set(headerBytes, preambleLen);
  out.fill(0x20, preambleLen + headerBytes.length, preambleLen + headerLen - 1);
  out[preambleLen + headerLen - 1] = 0x0a;
  out.set(data, preambleLen + headerLen);
  return out;
}

function npy(descr: string, shape: string, data: Uint8Array = new Uint8Array(0), fortran = false) {
  return npyFromHeader(
    `{'descr': '${descr}', 'fortran_order': ${fortran ? 'True' : 'False'}, 'shape': ${shape}, }`,
    data,
  );
}

function f64Bytes(values: number[], le = true): Uint8Array {
  const out = new Uint8Array(values.length * 8);
  const dv = new DataView(out.buffer);
  values.forEach((v, i) => dv.setFloat64(i * 8, v, le));
  return out;
}

// --- real numpy fixture ---

const FIXTURE_URL = new URL('../__fixtures__/dtypes.npz', import.meta.url);
const fixture = parseNpz(toArrayBuffer(readFileSync(fileURLToPath(FIXTURE_URL))));
const BASE = [0, 1, 2, 3, 4, 5];

describe('parseNpy: dtypes written by real numpy', () => {
  const cases: [string, string, new (n: number) => ArrayLike<number>][] = [
    ['float16', '<f2', Float32Array],
    ['float32', '<f4', Float32Array],
    ['float64', '<f8', Float64Array],
    ['int8', '|i1', Int8Array],
    ['int16', '<i2', Int16Array],
    ['int32', '<i4', Int32Array],
    ['int64', '<i8', Float64Array],
    ['uint8', '|u1', Uint8Array],
    ['uint16', '<u2', Uint16Array],
    ['uint32', '<u4', Uint32Array],
    ['uint64', '<u8', Float64Array],
  ];

  it.each(cases)('%s (%s) decodes exactly into %O', (name, descr, Ctor) => {
    const arr = fixture.arrays[name];
    expect(arr.dtype).toBe(descr);
    expect(arr.shape).toEqual([2, 3]);
    expect(arr.fortranOrder).toBe(false);
    expect(arr.data).toBeInstanceOf(Ctor);
    expect(Array.from(arr.data)).toEqual(BASE);
  });

  it.each(cases)('big-endian %s decodes to the same values', (name, descr, Ctor) => {
    const arr = fixture.arrays[`be_${name}`];
    // numpy writes '|' for 1-byte types regardless of the requested order.
    const expectedDescr = descr.startsWith('|') ? descr : `>${descr.slice(1)}`;
    expect(arr.dtype).toBe(expectedDescr);
    expect(arr.data).toBeInstanceOf(Ctor);
    expect(Array.from(arr.data)).toEqual(BASE);
  });

  it('bool (|b1) decodes to a Uint8Array of 0/1', () => {
    const arr = fixture.arrays['bool'];
    expect(arr.dtype).toBe('|b1');
    expect(arr.data).toBeInstanceOf(Uint8Array);
    expect(Array.from(arr.data)).toEqual([0, 1, 0, 1, 0, 1]);
  });

  it('Fortran-order arrays are flagged and processNpyResult restores C order', () => {
    const arr = fixture.arrays['fortran_float64'];
    expect(arr.fortranOrder).toBe(true);
    expect(Array.from(arr.data)).toEqual([0, 3, 1, 4, 2, 5]); // column-major on disk
    const c = processNpyResult(arr);
    expect(c.fortranOrder).toBe(false);
    expect(Array.from(c.data)).toEqual(BASE);
  });

  it('zero-size dimensions give empty data with the declared shape', () => {
    expect(fixture.arrays['empty_0x5'].shape).toEqual([0, 5]);
    expect(fixture.arrays['empty_0x5'].data.length).toBe(0);
    expect(fixture.arrays['empty_3x0'].shape).toEqual([3, 0]);
    expect(fixture.arrays['empty_3x0'].data.length).toBe(0);
    expect(processNpyResult(fixture.arrays['empty_3x0']).data.length).toBe(0);
  });

  it('a 0-d scalar has shape [] and exactly one element', () => {
    const arr = fixture.arrays['scalar'];
    expect(arr.shape).toEqual([]);
    expect(Array.from(arr.data)).toEqual([7.5]);
  });
});

describe('parseNpy: dtype edge cases', () => {
  it('decodes float16 specials: subnormal, max, +/-inf, NaN, -0', () => {
    const halves = [0x3c00, 0xc000, 0x0001, 0x7bff, 0x7c00, 0xfc00, 0x7e00, 0x8000];
    const bytes = new Uint8Array(halves.length * 2);
    const dv = new DataView(bytes.buffer);
    halves.forEach((h, i) => dv.setUint16(i * 2, h, true));
    const r = parseNpy(toArrayBuffer(npy('<f2', `(${halves.length},)`, bytes)));
    const v = Array.from(r.data);
    expect(v.slice(0, 6)).toEqual([1, -2, 2 ** -24, 65504, Infinity, -Infinity]);
    expect(Number.isNaN(v[6])).toBe(true);
    expect(Object.is(v[7], -0)).toBe(true);
  });

  it('big-endian float16 decodes the same as little-endian', () => {
    const bytes = new Uint8Array([0x3c, 0x00, 0xc0, 0x00]); // 1.0, -2.0 big-endian
    const r = parseNpy(toArrayBuffer(npy('>f2', '(2,)', bytes)));
    expect(Array.from(r.data)).toEqual([1, -2]);
  });

  it('64-bit integers widen to Float64, including negative and > 2^53 values', () => {
    const bytes = new Uint8Array(24);
    const dv = new DataView(bytes.buffer);
    dv.setBigInt64(0, -5n, true);
    dv.setBigInt64(8, 2n ** 53n, true);
    dv.setBigInt64(16, -(2n ** 63n), true);
    expect(Array.from(parseNpy(toArrayBuffer(npy('<i8', '(3,)', bytes))).data)).toEqual([
      -5,
      2 ** 53,
      -(2 ** 63),
    ]);
    const ubytes = new Uint8Array(8);
    new DataView(ubytes.buffer).setBigUint64(0, 2n ** 64n - 1n, true);
    expect(parseNpy(toArrayBuffer(npy('<u8', '(1,)', ubytes))).data[0]).toBe(2 ** 64);
  });

  it('bool bytes other than 0/1 normalise to 1', () => {
    const r = parseNpy(toArrayBuffer(npy('|b1', '(3,)', new Uint8Array([0, 2, 255]))));
    expect(Array.from(r.data)).toEqual([0, 1, 1]);
  });

  it.each(['<c16', '<c8', '|S5', '<U3', '|O', '|V8', '=f8', '|f8', '<f16', 'f8', '<m8'])(
    'rejects unsupported dtype %s with an app-neutral message',
    (descr) => {
      const fn = () => parseNpy(toArrayBuffer(npy(descr, '(1,)', new Uint8Array(16))));
      expect(fn).toThrow(/^Unsupported dtype/);
      try {
        fn();
      } catch (e) {
        expect((e as Error).message).not.toMatch(/CaTune|CaDecon|CaRank/);
      }
    },
  );

  it('rejects structured (record) dtypes as an unparseable header', () => {
    const header =
      "{'descr': [('a', '<f4'), ('b', '<i4')], 'fortran_order': False, 'shape': (2,), }";
    expect(() => parseNpy(toArrayBuffer(npyFromHeader(header, new Uint8Array(16))))).toThrow(
      'Failed to parse .npy header',
    );
  });
});

describe('parseNpy: shapes', () => {
  it.each([
    ['(-1, 4)', 'invalid dimension'],
    ['(2.5,)', 'invalid dimension'],
    ['(abc,)', 'invalid dimension'],
    ['(1e3,)', 'invalid dimension'],
    ['(9007199254740993,)', 'invalid dimension'], // > MAX_SAFE_INTEGER
    ['(4294967296, 4294967296)', 'overflows'], // 2^64 elements
    ['(1125899906842624,)', 'overflows'], // 2^50 elements x 8 bytes = 2^53
  ])('rejects shape %s', (shape, msg) => {
    expect(() => parseNpy(toArrayBuffer(npy('<f8', shape, new Uint8Array(64))))).toThrow(msg);
  });

  it('rejects a large-but-representable shape that the data does not back', () => {
    expect(() => parseNpy(toArrayBuffer(npy('<f8', '(100000, 100000)')))).toThrow('truncated');
  });

  it('accepts (0,) and py2-style long dims (3L,)', () => {
    expect(parseNpy(toArrayBuffer(npy('<f4', '(0,)'))).data.length).toBe(0);
    const r = parseNpy(toArrayBuffer(npy('<f8', '(3L,)', f64Bytes([1, 2, 3]))));
    expect(r.shape).toEqual([3]);
    expect(Array.from(r.data)).toEqual([1, 2, 3]);
  });

  it('ignores trailing bytes beyond the declared shape', () => {
    const r = parseNpy(toArrayBuffer(npy('<f8', '(2,)', f64Bytes([1, 2, 3, 4]))));
    expect(Array.from(r.data)).toEqual([1, 2]);
  });
});

describe('parseNpy: truncated and corrupt files', () => {
  const valid = npy('<f8', '(2, 3)', f64Bytes(BASE));

  it('every truncation of a valid file fails with a parser error', () => {
    for (let cut = 0; cut < valid.length; cut++) {
      expect(() => parseNpy(toArrayBuffer(valid.subarray(0, cut))), `cut=${cut}`).toThrow(
        /Not a valid \.npy file|truncated|Failed to parse/,
      );
    }
  });

  it('a v2 header claiming 4 GiB is reported as truncated, not allocated', () => {
    const bytes = npyFromHeader(
      "{'descr': '<f8', 'fortran_order': False, 'shape': (1,), }",
      f64Bytes([1]),
      2,
    );
    new DataView(bytes.buffer).setUint32(8, 0xffffffff, true);
    expect(() => parseNpy(toArrayBuffer(bytes))).toThrow('truncated in header');
  });

  it('parses a version 3.0 (utf-8 header) file', () => {
    const bytes = npyFromHeader(
      "{'descr': '<f8', 'fortran_order': False, 'shape': (2,), }",
      f64Bytes([1, 2]),
      3,
    );
    expect(Array.from(parseNpy(toArrayBuffer(bytes)).data)).toEqual([1, 2]);
  });

  it('random byte corruption never escapes as a RangeError/TypeError', () => {
    const rand = rng(1234);
    for (let iter = 0; iter < 2000; iter++) {
      const bytes = valid.slice();
      const flips = 1 + Math.floor(rand() * 4);
      for (let f = 0; f < flips; f++) {
        bytes[Math.floor(rand() * bytes.length)] = Math.floor(rand() * 256);
      }
      expectCleanOutcome(() => parseNpy(toArrayBuffer(bytes)), `npy iter ${iter}`);
    }
  });
});

// --- .npz ---

/** Offsets of the size fields we patch to forge a zip bomb. */
function forgeDeclaredSize(zip: Uint8Array, size: number): Uint8Array {
  const out = zip.slice();
  const dv = new DataView(out.buffer);
  for (let i = 0; i + 4 <= out.length; i++) {
    const sig = dv.getUint32(i, true);
    if (sig === 0x04034b50) dv.setUint32(i + 22, size, true); // local header: uncompressed size
    if (sig === 0x02014b50) dv.setUint32(i + 24, size, true); // central dir: uncompressed size
  }
  return out;
}

describe('parseNpz: decompressed-size cap', () => {
  const smallNpy = npy('<f8', '(2,)', f64Bytes([1, 2]));

  it('defaults to 1 GiB', () => {
    expect(DEFAULT_MAX_DECOMPRESSED_BYTES).toBe(1024 * MiB);
  });

  it('rejects a forged declared size before inflating (zip-bomb style)', () => {
    // ~200-byte archive whose central directory claims a ~4 GiB entry.
    const bomb = forgeDeclaredSize(zipSync({ 'a.npy': smallNpy }), 0xfffffff0);
    expect(bomb.length).toBeLessThan(1024);
    let err: unknown;
    try {
      parseNpz(toArrayBuffer(bomb));
    } catch (e) {
      err = e;
    }
    // The size check runs in fflate's per-entry filter, before it allocates
    // the declared-size output buffer, so this is our error -- not a RangeError
    // or an out-of-memory crash from a 4 GiB allocation.
    expect(err).toBeInstanceOf(DecompressedSizeLimitError);
    const e = err as DecompressedSizeLimitError;
    expect(e.bytes).toBe(0xfffffff0);
    expect(e.limit).toBe(DEFAULT_MAX_DECOMPRESSED_BYTES);
    expect(e.message).toMatch(
      /\.npz file would decompress to at least 4\.00 GiB, above the 1\.00 GiB limit/,
    );
    expect(e.message).not.toMatch(/CaTune|CaDecon|CaRank/);
  });

  it('rejects a genuinely highly-compressible entry over a custom cap', () => {
    // 4 Mi float64 zeros = 32 MiB inflated, ~32 KiB compressed.
    const big = npy('<f8', '(4194304,)', new Uint8Array(32 * MiB));
    const zip = zipSync({ 'zeros.npy': big }, { level: 9 });
    expect(zip.length).toBeLessThan(MiB);
    expect(() => parseNpz(toArrayBuffer(zip), { maxDecompressedBytes: MiB })).toThrow(
      DecompressedSizeLimitError,
    );
    const ok = parseNpz(toArrayBuffer(zip), { maxDecompressedBytes: 64 * MiB });
    expect(ok.arrays['zeros'].data.length).toBe(4194304);
  });

  it('sums sizes across entries', () => {
    const half = npy('<f8', '(76800,)', new Uint8Array(600 * 1024)); // ~600 KiB each
    const zip = toArrayBuffer(zipSync({ 'a.npy': half, 'b.npy': half }));
    expect(() => parseNpz(zip, { maxDecompressedBytes: MiB })).toThrow(DecompressedSizeLimitError);
    expect(parseNpz(zip, { maxDecompressedBytes: 2 * MiB }).arrayNames).toEqual(['a', 'b']);
  });

  it('does not count (or inflate) non-.npy entries', () => {
    const zip = zipSync({ 'notes.txt': new Uint8Array(4 * MiB), 'a.npy': smallNpy });
    const r = parseNpz(toArrayBuffer(zip), { maxDecompressedBytes: MiB });
    expect(r.arrayNames).toEqual(['a']);
  });

  it('Infinity disables the cap; invalid caps are rejected', () => {
    const zip = toArrayBuffer(zipSync({ 'a.npy': smallNpy }));
    expect(parseNpz(zip, { maxDecompressedBytes: Infinity }).arrayNames).toEqual(['a']);
    expect(() => parseNpz(zip, { maxDecompressedBytes: 0 })).toThrow(DecompressedSizeLimitError);
    expect(() => parseNpz(zip, { maxDecompressedBytes: -1 })).toThrow(TypeError);
    expect(() => parseNpz(zip, { maxDecompressedBytes: NaN })).toThrow(TypeError);
  });
});

describe('parseNpz: corrupt archives', () => {
  const zip = zipSync({
    'a.npy': npy('<f8', '(2, 3)', f64Bytes(BASE)),
    'b.npy': npy('<i4', '(2,)', new Uint8Array(8)),
  });

  it('reports a non-zip buffer as "Not a valid .npz file"', () => {
    expect(() => parseNpz(new ArrayBuffer(64))).toThrow(/^Not a valid \.npz file/);
    expect(() => parseNpz(new ArrayBuffer(0))).toThrow(/^Not a valid \.npz file/);
  });

  it('every truncation fails with a parser error', () => {
    for (let cut = 0; cut < zip.length; cut++) {
      expect(() => parseNpz(toArrayBuffer(zip.subarray(0, cut))), `cut=${cut}`).toThrow(
        /Not a valid \.npz file|\.npz entry|no \.npy arrays/,
      );
    }
  });

  it('names the entry when an embedded .npy is corrupt', () => {
    const bad = zipSync({ 'traces.npy': new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) });
    expect(() => parseNpz(toArrayBuffer(bad))).toThrow(
      /^\.npz entry "traces\.npy": Not a valid \.npy file/,
    );
  });

  it('rejects an end-of-directory record that claims more entries than fit', () => {
    const forged = zip.slice();
    const dv = new DataView(forged.buffer);
    const eocd = forged.length - 22;
    expect(dv.getUint32(eocd, true)).toBe(0x06054b50);
    dv.setUint16(eocd + 8, 0xffff, true);
    dv.setUint16(eocd + 10, 0xffff, true);
    expect(() => parseNpz(toArrayBuffer(forged))).toThrow(/^Not a valid \.npz file/);
  });

  it('random byte corruption never escapes as a RangeError/TypeError', () => {
    const rand = rng(99);
    for (let iter = 0; iter < 1000; iter++) {
      const bytes = zip.slice();
      const flips = 1 + Math.floor(rand() * 4);
      for (let f = 0; f < flips; f++) {
        bytes[Math.floor(rand() * bytes.length)] = Math.floor(rand() * 256);
      }
      expectCleanOutcome(
        () => parseNpz(toArrayBuffer(bytes), { maxDecompressedBytes: 16 * MiB }),
        `npz iter ${iter}`,
      );
    }
  });
});

// --- .mat (Level 5) builder ---

const mi = {
  INT8: 1,
  UINT8: 2,
  INT16: 3,
  UINT16: 4,
  INT32: 5,
  UINT32: 6,
  SINGLE: 7,
  DOUBLE: 9,
  INT64: 12,
  UINT64: 13,
  MATRIX: 14,
  COMPRESSED: 15,
} as const;
const mx = { DOUBLE: 6, SINGLE: 7, INT8: 8, UINT8: 9, INT16: 10, UINT16: 11, INT32: 12 } as const;
const mxForStorage: Record<number, number> = {
  [mi.INT8]: 8,
  [mi.UINT8]: 9,
  [mi.INT16]: 10,
  [mi.UINT16]: 11,
  [mi.INT32]: 12,
  [mi.UINT32]: 13,
  [mi.SINGLE]: 7,
  [mi.DOUBLE]: 6,
  [mi.INT64]: 14,
  [mi.UINT64]: 15,
};
const storageBytes: Record<number, number> = {
  [mi.INT8]: 1,
  [mi.UINT8]: 1,
  [mi.INT16]: 2,
  [mi.UINT16]: 2,
  [mi.INT32]: 4,
  [mi.UINT32]: 4,
  [mi.SINGLE]: 4,
  [mi.DOUBLE]: 8,
  [mi.INT64]: 8,
  [mi.UINT64]: 8,
};

function encode(mdtype: number, values: number[], le: boolean): Uint8Array {
  const size = storageBytes[mdtype];
  const out = new Uint8Array(values.length * size);
  const dv = new DataView(out.buffer);
  values.forEach((v, i) => {
    const o = i * size;
    switch (mdtype) {
      case mi.INT8:
        return dv.setInt8(o, v);
      case mi.UINT8:
        return dv.setUint8(o, v);
      case mi.INT16:
        return dv.setInt16(o, v, le);
      case mi.UINT16:
        return dv.setUint16(o, v, le);
      case mi.INT32:
        return dv.setInt32(o, v, le);
      case mi.UINT32:
        return dv.setUint32(o, v, le);
      case mi.SINGLE:
        return dv.setFloat32(o, v, le);
      case mi.DOUBLE:
        return dv.setFloat64(o, v, le);
      case mi.INT64:
        return dv.setBigInt64(o, BigInt(v), le);
      case mi.UINT64:
        return dv.setBigUint64(o, BigInt(v), le);
    }
  });
  return out;
}

function element(mdtype: number, data: Uint8Array, le: boolean): Uint8Array {
  const padded = data.length + ((8 - (data.length % 8)) % 8);
  const out = new Uint8Array(8 + padded);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, mdtype, le);
  dv.setUint32(4, data.length, le);
  out.set(data, 8);
  return out;
}

interface MatVar {
  name: string;
  dims: number[];
  values: number[]; // column-major
  storage?: number; // miXXX, default DOUBLE
  arrayClass?: number; // mxXXX, default matches storage
  flagsExtra?: number; // e.g. 0x0200 (logical)
}

function matrixElement(v: MatVar, le: boolean): Uint8Array {
  const storage = v.storage ?? mi.DOUBLE;
  const cls = v.arrayClass ?? mxForStorage[storage];
  const flags = element(mi.UINT32, encode(mi.UINT32, [cls | (v.flagsExtra ?? 0), 0], le), le);
  const dims = element(mi.INT32, encode(mi.INT32, v.dims, le), le);
  const name = element(mi.INT8, new TextEncoder().encode(v.name), le);
  const pr = element(storage, encode(storage, v.values, le), le);
  return element(mi.MATRIX, concat([flags, dims, name, pr]), le);
}

function compressedElement(inner: Uint8Array, le: boolean): Uint8Array {
  const z = zlibSync(inner);
  const out = new Uint8Array(8 + z.length); // compressed elements are unpadded
  const dv = new DataView(out.buffer);
  dv.setUint32(0, mi.COMPRESSED, le);
  dv.setUint32(4, z.length, le);
  out.set(z, 8);
  return out;
}

function matHeader(le: boolean): Uint8Array {
  const h = new Uint8Array(128);
  const desc = 'MATLAB 5.0 MAT-file, parser robustness tests';
  for (let i = 0; i < desc.length; i++) h[i] = desc.charCodeAt(i);
  new DataView(h.buffer).setUint16(124, 0x0100, le);
  if (le)
    h.set([0x49, 0x4d], 126); // 'IM'
  else h.set([0x4d, 0x49], 126); // 'MI'
  return h;
}

function mat(vars: MatVar[], { le = true, compress = false } = {}): ArrayBuffer {
  const els = vars.map((v) => {
    const m = matrixElement(v, le);
    return compress ? compressedElement(m, le) : m;
  });
  return toArrayBuffer(concat([matHeader(le), ...els]));
}

describe('parseMat: storage types and byte order', () => {
  const values = [0, 1, 2, 3, 4, 5]; // 2 x 3, column-major
  const storages: [string, number, new (n: number) => ArrayLike<number>][] = [
    ['int8', mi.INT8, Int8Array],
    ['uint8', mi.UINT8, Uint8Array],
    ['int16', mi.INT16, Int16Array],
    ['uint16', mi.UINT16, Uint16Array],
    ['int32', mi.INT32, Int32Array],
    ['uint32', mi.UINT32, Uint32Array],
    ['single', mi.SINGLE, Float32Array],
    ['double', mi.DOUBLE, Float64Array],
    ['int64', mi.INT64, Float64Array],
    ['uint64', mi.UINT64, Float64Array],
  ];

  for (const le of [true, false]) {
    for (const compress of [false, true]) {
      const label = `${le ? 'little' : 'big'}-endian${compress ? ', compressed' : ''}`;
      it.each(storages)(`%s (${label})`, (_n, storage, Ctor) => {
        const r = parseMat(mat([{ name: 'x', dims: [2, 3], values, storage }], { le, compress }));
        const arr = r.arrays['x'];
        expect(arr.shape).toEqual([2, 3]);
        expect(arr.fortranOrder).toBe(true);
        expect(arr.data).toBeInstanceOf(Ctor);
        expect(Array.from(arr.data)).toEqual(values);
        expect(Array.from(processNpyResult(arr).data)).toEqual([0, 2, 4, 1, 3, 5]);
      });
    }
  }

  it('reads a double-class array stored in a smaller integer type (MATLAB storage compaction)', () => {
    const r = parseMat(
      mat([
        { name: 'x', dims: [1, 3], values: [1, 2, 250], storage: mi.UINT8, arrayClass: mx.DOUBLE },
      ]),
    );
    expect(Array.from(r.arrays['x'].data)).toEqual([1, 2, 250]);
  });

  it('reads a logical (bool) array as 0/1', () => {
    const r = parseMat(
      mat([
        {
          name: 'mask',
          dims: [1, 4],
          values: [1, 0, 1, 1],
          storage: mi.UINT8,
          arrayClass: mx.UINT8,
          flagsExtra: 0x0200,
        },
      ]),
    );
    expect(Array.from(r.arrays['mask'].data)).toEqual([1, 0, 1, 1]);
  });

  it('accepts zero-size dimensions', () => {
    const r = parseMat(mat([{ name: 'e', dims: [0, 5], values: [] }]));
    expect(r.arrays['e'].shape).toEqual([0, 5]);
    expect(r.arrays['e'].data.length).toBe(0);
    expect(processNpyResult(r.arrays['e']).data.length).toBe(0);
  });
});

describe('parseMat: inconsistent shapes and corrupt files', () => {
  it('rejects dims that disagree with the stored element count', () => {
    expect(() => parseMat(mat([{ name: 'x', dims: [3, 3], values: [1, 2, 3, 4] }]))).toThrow(
      /Not a valid \.mat file: variable "x" declares dimensions \[3, 3\] \(9 elements\) but stores 4/,
    );
  });

  it('rejects negative dims', () => {
    expect(() => parseMat(mat([{ name: 'x', dims: [-1, 4], values: [] }]))).toThrow(
      'invalid dimensions',
    );
  });

  it('rejects dims whose product overflows', () => {
    const huge = 2 ** 31 - 1;
    expect(() => parseMat(mat([{ name: 'x', dims: [huge, huge, huge], values: [] }]))).toThrow(
      'overflow',
    );
  });

  it('every truncation of a valid file fails with a parser error', () => {
    const valid = new Uint8Array(
      mat([
        { name: 'a', dims: [2, 3], values: BASE },
        { name: 'b', dims: [1, 2], values: [7, 8], storage: mi.INT16 },
      ]),
    );
    // A cut exactly on an element boundary is indistinguishable from a file
    // that simply holds fewer variables; any other cut must fail loudly
    // rather than silently drop a variable.
    const aEnd = 128 + 112; // header + 'a' (8 tag + 16 flags + 16 dims + 16 name + 56 data)
    for (let cut = 0; cut < valid.length; cut++) {
      const parse = () => parseMat(toArrayBuffer(valid.subarray(0, cut)));
      if (cut === aEnd) {
        expect(parse().arrayNames, `cut=${cut}`).toEqual(['a']);
      } else {
        expect(parse, `cut=${cut}`).toThrow(/Not a valid \.mat file|no numeric arrays/);
      }
    }
  });

  it('also for compressed variables', () => {
    const valid = new Uint8Array(
      mat([{ name: 'a', dims: [2, 3], values: BASE }], { compress: true }),
    );
    for (let cut = 128; cut < valid.length; cut++) {
      expect(() => parseMat(toArrayBuffer(valid.subarray(0, cut))), `cut=${cut}`).toThrow(
        /Not a valid \.mat file|no numeric arrays/,
      );
    }
  });

  it('reports a corrupt zlib stream clearly', () => {
    const bytes = new Uint8Array(
      mat([{ name: 'a', dims: [2, 3], values: BASE }], { compress: true }),
    );
    for (let i = 128 + 8 + 2; i < bytes.length - 4; i++) bytes[i] ^= 0xa5; // keep zlib header
    expect(() => parseMat(toArrayBuffer(bytes))).toThrow(/^Not a valid \.mat file/);
  });

  it('no app name in the "no numeric arrays" message', () => {
    try {
      parseMat(toArrayBuffer(matHeader(true)));
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toMatch('contains no numeric arrays');
      expect((e as Error).message).not.toMatch(/CaTune|CaDecon|CaRank/);
    }
  });

  it('random byte corruption never escapes as a RangeError/TypeError', () => {
    const plain = new Uint8Array(mat([{ name: 'a', dims: [2, 3], values: BASE }]));
    const packed = new Uint8Array(
      mat([{ name: 'b', dims: [2, 3], values: BASE, storage: mi.INT32 }], { compress: true }),
    );
    const rand = rng(7);
    for (const base of [plain, packed]) {
      for (let iter = 0; iter < 1000; iter++) {
        const bytes = base.slice();
        const flips = 1 + Math.floor(rand() * 4);
        for (let f = 0; f < flips; f++) {
          // Leave the 128-byte header alone; it only gates the format check.
          bytes[128 + Math.floor(rand() * (bytes.length - 128))] = Math.floor(rand() * 256);
        }
        expectCleanOutcome(
          () => parseMat(toArrayBuffer(bytes), { maxDecompressedBytes: 16 * MiB }),
          `mat iter ${iter}`,
        );
      }
    }
  });
});

describe('parseMat: decompressed-size cap', () => {
  // 8 Mi doubles of zeros: 64 MiB inflated, ~64 KiB compressed.
  const N = 8 * 1024 * 1024;
  const bombVar: MatVar = { name: 'zeros', dims: [1, N], values: [] };
  const bomb = (() => {
    const flags = element(mi.UINT32, encode(mi.UINT32, [mx.DOUBLE, 0], true), true);
    const dims = element(mi.INT32, encode(mi.INT32, bombVar.dims, true), true);
    const name = element(mi.INT8, new TextEncoder().encode(bombVar.name), true);
    const pr = element(mi.DOUBLE, new Uint8Array(N * 8), true);
    const m = element(mi.MATRIX, concat([flags, dims, name, pr]), true);
    return toArrayBuffer(concat([matHeader(true), compressedElement(m, true)]));
  })();

  it('stops inflating a zlib bomb shortly after the cap, not after the full output', () => {
    expect(bomb.byteLength).toBeLessThan(MiB);
    let err: unknown;
    try {
      parseMat(bomb, { maxDecompressedBytes: MiB });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DecompressedSizeLimitError);
    const e = err as DecompressedSizeLimitError;
    expect(e.limit).toBe(MiB);
    // Streaming inflate checks after every 16 KiB input chunk, so at most
    // ~16 MiB past the cap was produced -- far short of the 64 MiB payload.
    expect(e.bytes).toBeGreaterThan(MiB);
    expect(e.bytes).toBeLessThan(18 * MiB);
    expect(e.message).toMatch(/^\.mat file would decompress/);
  });

  it('parses the same file when the cap allows it', () => {
    const r = parseMat(bomb, { maxDecompressedBytes: 128 * MiB });
    expect(r.arrays['zeros'].data.length).toBe(N);
  });

  it('sums inflated bytes across compressed variables', () => {
    const values = new Array(76800).fill(1); // 600 KiB of doubles each
    const file = mat(
      [
        { name: 'a', dims: [1, values.length], values },
        { name: 'b', dims: [1, values.length], values },
      ],
      { compress: true },
    );
    expect(() => parseMat(file, { maxDecompressedBytes: MiB })).toThrow(DecompressedSizeLimitError);
    expect(parseMat(file, { maxDecompressedBytes: 2 * MiB }).arrayNames).toEqual(['a', 'b']);
  });

  it('does not apply to uncompressed (v6) variables, which are already in memory', () => {
    const values = new Array(200000).fill(2); // 1.5 MiB
    const r = parseMat(mat([{ name: 'v', dims: [1, values.length], values }]), {
      maxDecompressedBytes: MiB,
    });
    expect(r.arrays['v'].data.length).toBe(values.length);
  });
});
