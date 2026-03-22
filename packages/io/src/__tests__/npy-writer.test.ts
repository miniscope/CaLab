import { describe, it, expect } from 'vitest';
import { writeNpy } from '../npy-writer.ts';
import { parseNpy } from '../npy-parser.ts';

describe('writeNpy', () => {
  describe('roundtrip with parseNpy', () => {
    it('roundtrips a 2D float32 array', () => {
      const data = new Float32Array([1.0, 2.0, 3.0, 4.0, 5.0, 6.0]);
      const shape = [2, 3];

      const buffer = writeNpy(data, shape);
      const result = parseNpy(buffer);

      expect(result.shape).toEqual([2, 3]);
      expect(result.dtype).toBe('<f4');
      expect(result.fortranOrder).toBe(false);
      expect(result.data).toBeInstanceOf(Float32Array);
      expect(result.data.length).toBe(6);
      for (let i = 0; i < 6; i++) {
        expect(result.data[i]).toBeCloseTo(data[i], 5);
      }
    });

    it('roundtrips a 1D float32 array', () => {
      const data = new Float32Array([10.5, 20.5, 30.5]);
      const shape = [3];

      const buffer = writeNpy(data, shape);
      const result = parseNpy(buffer);

      expect(result.shape).toEqual([3]);
      expect(result.data.length).toBe(3);
      expect(result.data[0]).toBeCloseTo(10.5, 5);
      expect(result.data[2]).toBeCloseTo(30.5, 5);
    });

    it('roundtrips a larger matrix', () => {
      const rows = 10;
      const cols = 500;
      const data = new Float32Array(rows * cols);
      for (let i = 0; i < data.length; i++) {
        data[i] = Math.sin(i * 0.01);
      }

      const buffer = writeNpy(data, [rows, cols]);
      const result = parseNpy(buffer);

      expect(result.shape).toEqual([rows, cols]);
      expect(result.data.length).toBe(rows * cols);
      for (let i = 0; i < 10; i++) {
        expect(result.data[i]).toBeCloseTo(data[i], 5);
      }
    });
  });

  describe('binary format', () => {
    it('starts with correct magic bytes', () => {
      const data = new Float32Array([1.0]);
      const buffer = writeNpy(data, [1]);
      const bytes = new Uint8Array(buffer);

      // \x93NUMPY
      expect(bytes[0]).toBe(0x93);
      expect(bytes[1]).toBe(0x4e);
      expect(bytes[2]).toBe(0x55);
      expect(bytes[3]).toBe(0x4d);
      expect(bytes[4]).toBe(0x50);
      expect(bytes[5]).toBe(0x59);
    });

    it('uses version 1.0', () => {
      const data = new Float32Array([1.0]);
      const buffer = writeNpy(data, [1]);
      const bytes = new Uint8Array(buffer);

      expect(bytes[6]).toBe(1); // major
      expect(bytes[7]).toBe(0); // minor
    });

    it('header + preamble is 64-byte aligned', () => {
      const data = new Float32Array([1.0, 2.0]);
      const buffer = writeNpy(data, [2]);
      const view = new DataView(buffer);

      const headerLen = view.getUint16(8, true);
      const totalPreamble = 10 + headerLen; // magic(6) + version(2) + headerLen(2) + header
      expect(totalPreamble % 64).toBe(0);
    });

    it('header terminates with newline', () => {
      const data = new Float32Array([1.0]);
      const buffer = writeNpy(data, [1]);
      const view = new DataView(buffer);
      const bytes = new Uint8Array(buffer);

      const headerLen = view.getUint16(8, true);
      // Last byte of header should be newline
      expect(bytes[10 + headerLen - 1]).toBe(0x0a);
    });
  });
});
