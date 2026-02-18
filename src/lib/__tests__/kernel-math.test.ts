import { describe, it, expect } from 'vitest';
import { computeKernel } from '../chart/kernel-math.ts';

describe('computeKernel', () => {
  const tauRise = 0.02;
  const tauDecay = 0.4;
  const fs = 30;

  it('normalizes peak value to 1.0', () => {
    const { y } = computeKernel(tauRise, tauDecay, fs);
    const peak = Math.max(...y);
    expect(peak).toBeCloseTo(1.0, 10);
  });

  it('first value is approximately 0 (exp(0)-exp(0) = 0)', () => {
    const { y } = computeKernel(tauRise, tauDecay, fs);
    // At t=0: exp(0/decay) - exp(0/rise) = 1 - 1 = 0
    expect(y[0]).toBeCloseTo(0, 5);
  });

  it('kernel length matches ceil(durationMultiple * tauDecay * fs)', () => {
    const durationMultiple = 5;
    const { x, y } = computeKernel(tauRise, tauDecay, fs, durationMultiple);
    const expectedLength = Math.ceil(durationMultiple * tauDecay * fs);
    expect(y.length).toBe(expectedLength);
    expect(x.length).toBe(expectedLength);
  });

  it('larger tauDecay produces wider kernel', () => {
    const narrowKernel = computeKernel(tauRise, 0.2, fs);
    const wideKernel = computeKernel(tauRise, 0.8, fs);
    expect(wideKernel.y.length).toBeGreaterThan(narrowKernel.y.length);
  });

  it('returns matching x and y array lengths', () => {
    const { x, y } = computeKernel(tauRise, tauDecay, fs);
    expect(x.length).toBe(y.length);
  });

  it('uses default durationMultiple of 5', () => {
    const { y } = computeKernel(tauRise, tauDecay, fs);
    const expectedLength = Math.ceil(5 * tauDecay * fs);
    expect(y.length).toBe(expectedLength);
  });

  it('x values represent time in seconds with correct spacing', () => {
    const { x } = computeKernel(tauRise, tauDecay, fs);
    const dt = 1 / fs;
    expect(x[0]).toBeCloseTo(0, 10);
    expect(x[1]).toBeCloseTo(dt, 10);
    expect(x[2]).toBeCloseTo(2 * dt, 10);
  });

  it('kernel has correct double-exponential shape (rises then decays)', () => {
    const { y } = computeKernel(tauRise, tauDecay, fs);

    // Find peak index
    let peakIdx = 0;
    for (let i = 1; i < y.length; i++) {
      if (y[i] > y[peakIdx]) peakIdx = i;
    }

    // Values should generally increase to peak, then decrease
    expect(peakIdx).toBeGreaterThan(0);
    expect(peakIdx).toBeLessThan(y.length - 1);
    expect(y[peakIdx]).toBe(1.0);

    // Last value should be much smaller than peak
    expect(y[y.length - 1]).toBeLessThan(0.05);
  });
});
