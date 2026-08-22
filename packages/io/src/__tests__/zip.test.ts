import { describe, it, expect } from 'vitest';
import { unzipSync } from 'fflate';
import { zipFiles } from '../zip.ts';

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('zipFiles', () => {
  describe('happy path', () => {
    it('bundles named entries that unzip back byte-for-byte', () => {
      const files = {
        'results.json': bytes('{"fs":30}'),
        'activity.npy': new Uint8Array([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]),
      };

      const entries = unzipSync(new Uint8Array(zipFiles(files)));

      expect(Object.keys(entries).sort()).toEqual(['activity.npy', 'results.json']);
      expect(Array.from(entries['results.json'])).toEqual(Array.from(files['results.json']));
      expect(Array.from(entries['activity.npy'])).toEqual(Array.from(files['activity.npy']));
    });

    it('preserves arbitrary binary bytes, not just text', () => {
      // Every byte value, so a UTF-8 round trip anywhere in the path would corrupt it.
      const all = new Uint8Array(256);
      for (let i = 0; i < 256; i++) all[i] = i;

      const entries = unzipSync(new Uint8Array(zipFiles({ 'blob.bin': all })));

      expect(Array.from(entries['blob.bin'])).toEqual(Array.from(all));
    });

    it('returns an ArrayBuffer sized to the archive alone', () => {
      // fflate hands back a view that may sit inside a larger pooled buffer;
      // zipFiles slices it, so byteLength must be the archive's own length.
      const buffer = zipFiles({ 'a.txt': bytes('a') });

      expect(buffer).toBeInstanceOf(ArrayBuffer);
      expect(buffer.byteLength).toBe(new Uint8Array(buffer).length);
      // "PK\x03\x04" -- the archive really does start at offset 0.
      expect(Array.from(new Uint8Array(buffer, 0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    });

    it('deflates entries, as the doc comment claims', () => {
      // Pins the documented behaviour: byte 8 of the local file header is the
      // compression method, 8 = deflate (0 would be stored). Consumers do not
      // care -- every ZIP reader handles both -- but the comment should not rot.
      const buffer = zipFiles({ 'a.txt': bytes('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') });

      expect(new DataView(buffer).getUint16(8, true)).toBe(8);
    });

    it('bundles a single entry', () => {
      const entries = unzipSync(new Uint8Array(zipFiles({ 'only.json': bytes('{}') })));

      expect(Object.keys(entries)).toEqual(['only.json']);
      expect(new TextDecoder().decode(entries['only.json'])).toBe('{}');
    });
  });

  describe('edge cases', () => {
    it('writes a valid empty archive for an empty file map', () => {
      const buffer = zipFiles({});

      expect(unzipSync(new Uint8Array(buffer))).toEqual({});
    });

    it('keeps a zero-length entry as a zero-length entry', () => {
      const entries = unzipSync(new Uint8Array(zipFiles({ 'empty.json': new Uint8Array(0) })));

      expect(Object.keys(entries)).toEqual(['empty.json']);
      expect(entries['empty.json'].length).toBe(0);
    });
  });
});
