import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseMat } from '../mat-parser.ts';
import { processNpyResult } from '../array-utils.ts';
import { zlibSync } from 'fflate';

// --- MAT Level 5 builder helpers ---

const miINT8 = 1;
const miUINT32 = 6;
const miINT32 = 5;
const miDOUBLE = 9;
const miMATRIX = 14;
const miCOMPRESSED = 15;
const mxDOUBLE = 6;

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** Build a standard-format data element (8-byte tag + padded data). */
function element(mdtype: number, data: Uint8Array): Uint8Array {
  const padded = data.length + ((8 - (data.length % 8)) % 8);
  const buf = new Uint8Array(8 + padded);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, mdtype, true);
  dv.setUint32(4, data.length, true);
  buf.set(data, 8);
  return buf;
}

function u32(values: number[]): Uint8Array {
  const buf = new Uint8Array(values.length * 4);
  const dv = new DataView(buf.buffer);
  values.forEach((v, i) => dv.setUint32(i * 4, v, true));
  return buf;
}

function i32(values: number[]): Uint8Array {
  const buf = new Uint8Array(values.length * 4);
  const dv = new DataView(buf.buffer);
  values.forEach((v, i) => dv.setInt32(i * 4, v, true));
  return buf;
}

function f64(values: number[]): Uint8Array {
  const buf = new Uint8Array(values.length * 8);
  const dv = new DataView(buf.buffer);
  values.forEach((v, i) => dv.setFloat64(i * 8, v, true));
  return buf;
}

/** Build the miMATRIX element for a real double variable (column-major data). */
function doubleMatrixElement(name: string, dims: number[], colMajorData: number[]): Uint8Array {
  const flags = element(miUINT32, u32([mxDOUBLE, 0]));
  const dimsEl = element(miINT32, i32(dims));
  const nameEl = element(miINT8, new TextEncoder().encode(name));
  const prEl = element(miDOUBLE, f64(colMajorData));
  const body = concat([flags, dimsEl, nameEl, prEl]);
  return element(miMATRIX, body);
}

function header(desc = 'MATLAB 5.0 MAT-file, created for tests'): Uint8Array {
  const h = new Uint8Array(128);
  for (let i = 0; i < desc.length && i < 116; i++) h[i] = desc.charCodeAt(i);
  const dv = new DataView(h.buffer);
  dv.setUint16(124, 0x0100, true); // version
  h[126] = 0x49; // 'I'
  h[127] = 0x4d; // 'M'  -> little-endian
  return h;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

// --- Tests ---

describe('parseMat', () => {
  describe('happy path (uncompressed v5/v6)', () => {
    it('parses a single 2D double matrix (column-major -> Fortran order)', () => {
      // Logical matrix [[1,2,3],[4,5,6]] (2x3) stored column-major.
      const mat = concat([header(), doubleMatrixElement('traces', [2, 3], [1, 4, 2, 5, 3, 6])]);

      const result = parseMat(toArrayBuffer(mat));

      expect(result.arrayNames).toEqual(['traces']);
      const arr = result.arrays['traces'];
      expect(arr.shape).toEqual([2, 3]);
      expect(arr.dtype).toBe('<f8');
      expect(arr.fortranOrder).toBe(true);
      expect(Array.from(arr.data)).toEqual([1, 4, 2, 5, 3, 6]);
    });

    it('processNpyResult transposes MATLAB column-major data to C order', () => {
      const mat = concat([header(), doubleMatrixElement('traces', [2, 3], [1, 4, 2, 5, 3, 6])]);
      const processed = processNpyResult(parseMat(toArrayBuffer(mat)).arrays['traces']);

      expect(processed.fortranOrder).toBe(false);
      expect(processed.shape).toEqual([2, 3]);
      // Row-major [[1,2,3],[4,5,6]]
      expect(Array.from(processed.data)).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it('parses multiple named variables', () => {
      const mat = concat([
        header(),
        doubleMatrixElement('traces', [2, 2], [1, 3, 2, 4]),
        doubleMatrixElement('fps', [1, 1], [30]),
      ]);

      const result = parseMat(toArrayBuffer(mat));

      expect(result.arrayNames).toContain('traces');
      expect(result.arrayNames).toContain('fps');
      expect(result.arrays['traces'].shape).toEqual([2, 2]);
      expect(result.arrays['fps'].shape).toEqual([1, 1]);
    });
  });

  describe('compressed (v7)', () => {
    // A compressed element is NOT padded to an 8-byte boundary (MAT spec
    // exception). Build it flush so tests match how MATLAB/scipy write it.
    const compressedElement = (matrixEl: Uint8Array): Uint8Array => {
      const compressed = zlibSync(matrixEl);
      const tag = new Uint8Array(8);
      const dv = new DataView(tag.buffer);
      dv.setUint32(0, miCOMPRESSED, true);
      dv.setUint32(4, compressed.length, true);
      return concat([tag, compressed]);
    };

    it('parses a zlib-compressed matrix element (miCOMPRESSED)', () => {
      const matrixEl = doubleMatrixElement('traces', [2, 3], [1, 4, 2, 5, 3, 6]);
      const mat = concat([header(), compressedElement(matrixEl)]);

      const result = parseMat(toArrayBuffer(mat));

      expect(result.arrayNames).toEqual(['traces']);
      expect(result.arrays['traces'].shape).toEqual([2, 3]);
      expect(Array.from(result.arrays['traces'].data)).toEqual([1, 4, 2, 5, 3, 6]);
    });

    it('parses consecutive compressed variables (unpadded element boundaries)', () => {
      // Regression: compressed elements are unpadded, so the next element must
      // start exactly at dataStart + byteCount, not the 8-byte-rounded offset.
      // Find a first element whose compressed length is NOT 8-aligned -- that is
      // precisely the case a padding bug would misalign the following element.
      let first: Uint8Array | null = null;
      for (let n = 1; n < 128 && !first; n++) {
        const el = compressedElement(
          doubleMatrixElement(
            'filler',
            [1, n],
            Array.from({ length: n }, (_, i) => i + 1),
          ),
        );
        if (el.length % 8 !== 0) first = el;
      }
      expect(first, 'expected to construct a non-8-aligned compressed element').not.toBeNull();

      const second = compressedElement(doubleMatrixElement('traces', [2, 2], [1, 3, 2, 4]));
      const mat = concat([header(), first as Uint8Array, second]);

      const result = parseMat(toArrayBuffer(mat));

      // If the compressed boundary were padded, `traces` would be missed.
      expect(result.arrayNames).toContain('filler');
      expect(result.arrayNames).toContain('traces');
      expect(result.arrays['traces'].shape).toEqual([2, 2]);
    });
  });

  describe('error cases', () => {
    it('rejects v7.3 (HDF5) files with a helpful message', () => {
      const mat = header('MATLAB 7.3 MAT-file, Platform: PCWIN64');
      expect(() => parseMat(toArrayBuffer(mat))).toThrow(/v7\.3/);
    });

    it('throws when the file contains no numeric arrays', () => {
      const mat = header(); // header only, no data elements
      expect(() => parseMat(toArrayBuffer(mat))).toThrow('contains no numeric arrays');
    });

    it('throws when the file is too small to hold a header', () => {
      expect(() => parseMat(new ArrayBuffer(64))).toThrow('file too small');
    });

    it('throws on a missing endian indicator', () => {
      const h = header();
      h[126] = 0;
      h[127] = 0;
      expect(() => parseMat(toArrayBuffer(h))).toThrow('endian indicator');
    });
  });
});

// Fixtures written by scipy (a genuine MATLAB Level-5 writer) -- see
// ../__fixtures__/gen-mat-fixtures.py. These guard against format-reality bugs
// that hand-built bytes cannot, e.g. the unpadded-compressed-element boundary
// that a synthetic builder originally got wrong. Each fixture holds
// `traces` = [[1..5],[6..10],[11..15]] (3 cells x 5 timepoints).
describe('parseMat: real scipy fixtures', () => {
  const fixture = (name: string): ArrayBuffer => {
    const path = fileURLToPath(new URL(`../__fixtures__/${name}`, import.meta.url));
    const b = readFileSync(path);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  };
  const C_ORDER = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

  it('reads an uncompressed (v6) file and round-trips values to C order', () => {
    const r = parseMat(fixture('traces_v6.mat'));
    expect(r.arrayNames).toEqual(['traces']);
    expect(r.arrays['traces'].shape).toEqual([3, 5]);
    expect(r.arrays['traces'].fortranOrder).toBe(true);
    const c = processNpyResult(r.arrays['traces']);
    expect(c.fortranOrder).toBe(false);
    expect(c.shape).toEqual([3, 5]);
    expect(Array.from(c.data)).toEqual(C_ORDER);
  });

  it('reads a compressed (v7) file with identical values', () => {
    const r = parseMat(fixture('traces_v7.mat'));
    expect(r.arrays['traces'].shape).toEqual([3, 5]);
    expect(Array.from(processNpyResult(r.arrays['traces']).data)).toEqual(C_ORDER);
  });

  it('reads a compressed multi-variable file (traces + fps + tvec)', () => {
    const r = parseMat(fixture('traces_multi.mat'));
    expect([...r.arrayNames].sort()).toEqual(['fps', 'traces', 'tvec']);
    expect(r.arrays['traces'].shape).toEqual([3, 5]);
    expect(Array.from(processNpyResult(r.arrays['traces']).data)).toEqual(C_ORDER);
    // MATLAB stores a scalar as 1x1 and a vector as 1xN.
    expect(r.arrays['fps'].shape).toEqual([1, 1]);
    expect(Array.from(r.arrays['fps'].data)).toEqual([30]);
    expect(r.arrays['tvec'].shape).toEqual([1, 5]);
    expect(Array.from(r.arrays['tvec'].data)).toEqual([0, 1, 2, 3, 4]);
  });
});
