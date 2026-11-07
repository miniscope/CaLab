import { describe, expect, it } from 'vitest';
import { displayRange, pixelCount, toGray8 } from '../lib/frame-display.ts';

describe('frame display', () => {
  it('uses the full range without auto contrast', () => {
    expect(displayRange(new Uint8Array([10, 20]), 8, false)).toEqual({ lo: 0, hi: 255 });
    expect(displayRange(new Uint8Array(4), 16, false)).toEqual({ lo: 0, hi: 65535 });
    expect(Array.from(toGray8(new Uint8Array([0, 128, 255]), 8, { lo: 0, hi: 255 }))).toEqual([
      0, 128, 255,
    ]);
  });

  it('stretches to the percentile range and clips hot pixels', () => {
    const px = new Uint8Array(10_000).fill(100);
    for (let i = 0; i < 5000; i++) px[i] = 120;
    px[0] = 255; // one hot pixel, below the 0.5% clip
    const { lo, hi } = displayRange(px, 8, true);
    expect(lo).toBeGreaterThanOrEqual(99);
    expect(hi).toBeLessThan(140);
    const gray = toGray8(px, 8, { lo, hi });
    expect(gray[0]).toBe(255);
    expect(gray[9999]).toBeLessThan(10);
  });

  it('handles flat and empty frames', () => {
    const r = displayRange(new Uint8Array(8).fill(7), 8, true);
    expect(r.hi).toBeGreaterThan(r.lo);
    expect(displayRange(new Uint8Array(0), 8, true)).toEqual({ lo: 0, hi: 255 });
  });

  it('reads 16-bit samples as little-endian pairs', () => {
    const bytes = new Uint16Array([0x1234, 0xffff]);
    expect(pixelCount(bytes, 16)).toBe(2);
    const gray = toGray8(bytes, 16, { lo: 0, hi: 65535 });
    expect(gray[0]).toBe(Math.round((0x1234 * 255) / 65535) | 0);
    expect(gray[1]).toBe(255);
  });
});
