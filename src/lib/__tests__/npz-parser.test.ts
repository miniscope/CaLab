import { describe, it, expect } from 'vitest';
import { parseNpz } from '../npz-parser.ts';
import { zipSync } from 'fflate';

// --- Test Helper: Build a valid .npy buffer for embedding in .npz ---

function makeNpyBuffer(
  data: number[],
  shape: number[],
  dtype: string,
  fortranOrder = false,
): ArrayBuffer {
  const shapeStr = shape.length === 1 ? `(${shape[0]},)` : `(${shape.join(', ')})`;
  const headerDict = `{'descr': '${dtype}', 'fortran_order': ${fortranOrder ? 'True' : 'False'}, 'shape': ${shapeStr}, }`;

  const preambleLen = 10; // version 1
  const headerBytes = new TextEncoder().encode(headerDict);
  let totalHeaderLen = headerBytes.length + 1;
  const remainder = (preambleLen + totalHeaderLen) % 64;
  if (remainder !== 0) {
    totalHeaderLen += 64 - remainder;
  }

  const dtypeBytes = getDtypeBytes(dtype);
  const dataBytes = data.length * dtypeBytes;
  const bufferSize = preambleLen + totalHeaderLen + dataBytes;
  const buffer = new ArrayBuffer(bufferSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  bytes[0] = 0x93;
  bytes[1] = 0x4e;
  bytes[2] = 0x55;
  bytes[3] = 0x4d;
  bytes[4] = 0x50;
  bytes[5] = 0x59;
  bytes[6] = 1;
  bytes[7] = 0;
  view.setUint16(8, totalHeaderLen, true);

  for (let i = 0; i < headerBytes.length; i++) {
    bytes[10 + i] = headerBytes[i];
  }
  for (let i = headerBytes.length; i < totalHeaderLen - 1; i++) {
    bytes[10 + i] = 0x20;
  }
  bytes[10 + totalHeaderLen - 1] = 0x0a;

  const dataOffset = preambleLen + totalHeaderLen;
  for (let i = 0; i < data.length; i++) {
    switch (dtype) {
      case '<f8':
        view.setFloat64(dataOffset + i * 8, data[i], true);
        break;
      case '<f4':
        view.setFloat32(dataOffset + i * 4, data[i], true);
        break;
    }
  }

  return buffer;
}

function getDtypeBytes(dtype: string): number {
  const map: Record<string, number> = {
    '<f8': 8,
    '<f4': 4,
    '<i4': 4,
    '<i2': 2,
    '<i1': 1,
    '|i1': 1,
    '<u4': 4,
    '<u2': 2,
    '<u1': 1,
    '|u1': 1,
  };
  return map[dtype] ?? 8;
}

// --- Helper: Build a .npz buffer (zip archive) from named .npy entries ---

function makeNpzBuffer(entries: Record<string, ArrayBuffer>): ArrayBuffer {
  const zipEntries: Record<string, Uint8Array> = {};
  for (const [name, buf] of Object.entries(entries)) {
    zipEntries[name] = new Uint8Array(buf);
  }
  const zipped = zipSync(zipEntries);
  const copy = new Uint8Array(zipped);
  return copy.buffer as ArrayBuffer;
}

// --- Tests ---

describe('parseNpz', () => {
  describe('happy path', () => {
    it('parses .npz with single .npy entry "arr_0.npy"', () => {
      const npyBuf = makeNpyBuffer([1.0, 2.0, 3.0, 4.0, 5.0, 6.0], [2, 3], '<f8');
      const npzBuf = makeNpzBuffer({ 'arr_0.npy': npyBuf });

      const result = parseNpz(npzBuf);

      expect(result.arrayNames).toEqual(['arr_0']);
      expect(result.arrays['arr_0']).toBeDefined();
      expect(result.arrays['arr_0'].shape).toEqual([2, 3]);
      expect(result.arrays['arr_0'].dtype).toBe('<f8');
      expect(result.arrays['arr_0'].data.length).toBe(6);
    });

    it('parses .npz with multiple named .npy entries', () => {
      const traces = makeNpyBuffer([1, 2, 3, 4], [2, 2], '<f8');
      const timestamps = makeNpyBuffer([0.1, 0.2, 0.3], [3], '<f4');

      const npzBuf = makeNpzBuffer({
        'traces.npy': traces,
        'timestamps.npy': timestamps,
      });

      const result = parseNpz(npzBuf);

      expect(result.arrayNames).toContain('traces');
      expect(result.arrayNames).toContain('timestamps');
      expect(result.arrays['traces'].shape).toEqual([2, 2]);
      expect(result.arrays['timestamps'].shape).toEqual([3]);
    });

    it('skips non-.npy entries (metadata files)', () => {
      const npyBuf = makeNpyBuffer([1, 2, 3], [3], '<f8');
      const metadataBytes = new TextEncoder().encode('{"key": "value"}');

      const npzBuf = makeNpzBuffer({
        'arr_0.npy': npyBuf,
        'metadata.json': metadataBytes.buffer.slice(
          metadataBytes.byteOffset,
          metadataBytes.byteOffset + metadataBytes.byteLength,
        ),
      });

      const result = parseNpz(npzBuf);

      expect(result.arrayNames).toEqual(['arr_0']);
      expect(result.arrays['metadata.json']).toBeUndefined();
    });
  });

  describe('error cases', () => {
    it('throws when .npz contains no .npy entries', () => {
      const textBytes = new TextEncoder().encode('hello');
      const npzBuf = makeNpzBuffer({
        'readme.txt': textBytes.buffer.slice(
          textBytes.byteOffset,
          textBytes.byteOffset + textBytes.byteLength,
        ),
      });

      expect(() => parseNpz(npzBuf)).toThrow('.npz file contains no .npy arrays');
    });

    it('propagates error from corrupted zip data', () => {
      // Create garbage data that is not a valid zip
      const garbage = new ArrayBuffer(64);
      const bytes = new Uint8Array(garbage);
      for (let i = 0; i < 64; i++) bytes[i] = i;

      expect(() => parseNpz(garbage)).toThrow();
    });
  });
});
