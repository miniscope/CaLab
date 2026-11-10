import { describe, expect, it } from 'vitest';
import {
  displayRange,
  FIT_FRAMES,
  percentileRange,
  pixelCount,
  RangeHold,
  toGray8,
} from '../lib/frame-display.ts';

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

  describe('RangeHold (fixed range, no auto-contrast)', () => {
    const frame = (base: number, amp: number) => {
      const f = new Float32Array(10_000).fill(base);
      for (let i = 0; i < 5000; i++) f[i] = base + amp;
      return f;
    };

    it('percentileRange ignores a few hot pixels', () => {
      const f = frame(100, 20);
      f[0] = 5000;
      const r = percentileRange([f])!;
      expect(r.lo).toBe(100);
      expect(r.hi).toBe(120);
      expect(percentileRange([])).toBeNull();
    });

    it('is computed once from the first frames, then held', () => {
      const hold = new RangeHold();
      for (let i = 0; i < FIT_FRAMES; i++) hold.observe(frame(100, 20));
      expect(hold.locked).toBe(true);
      const fitted = { ...hold.range! };
      // A real amplitude change later must not move the range, and must clip.
      for (let i = 0; i < 30; i++) expect(hold.observe(frame(100, 400))).toEqual(fitted);
      const gray = toGray8(frame(100, 400), 0, hold.range!);
      expect(gray[0]).toBe(255);
      expect(gray[9999]).toBe(0);
    });

    it('pools the warm-up frames', () => {
      const hold = new RangeHold(2);
      hold.observe(frame(100, 20));
      expect(hold.locked).toBe(false);
      hold.observe(frame(100, 60));
      expect(hold.locked).toBe(true);
      expect(hold.range).toEqual({ lo: 100, hi: 160 });
    });

    it('manual override is held and survives new frames', () => {
      const hold = new RangeHold(1);
      hold.observe(frame(100, 20));
      hold.setManual({ lo: 90, hi: 300 });
      expect(hold.observe(frame(500, 20))).toEqual({ lo: 90, hi: 300 });
      hold.setManual({ lo: 5, hi: 5 }); // invalid, ignored
      expect(hold.range).toEqual({ lo: 90, hi: 300 });
    });

    it('re-fit recomputes once from recent frames and holds again', () => {
      const hold = new RangeHold(2);
      hold.observe(frame(100, 20));
      hold.observe(frame(100, 20));
      for (let i = 0; i < 2; i++) hold.observe(frame(500, 50));
      expect(hold.range).toEqual({ lo: 100, hi: 120 });
      hold.refit();
      expect(hold.range).toEqual({ lo: 500, hi: 550 });
      expect(hold.observe(frame(900, 50))).toEqual({ lo: 500, hi: 550 });
    });

    it('reset starts a fresh fit for a new run', () => {
      const hold = new RangeHold(1);
      hold.observe(frame(100, 20));
      hold.reset();
      expect(hold.range).toBeNull();
      expect(hold.locked).toBe(false);
      expect(hold.observe(frame(500, 50))).toEqual({ lo: 500, hi: 550 });
    });
  });
});
