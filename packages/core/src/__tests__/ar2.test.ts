import { describe, it, expect } from 'vitest';
import { computeAR2 } from '../ar2.ts';

describe('computeAR2', () => {
  it('computes hand-verified values for tauRise=0.01, tauDecay=1.0, fs=30', () => {
    const result = computeAR2(0.01, 1.0, 30);
    const dt = 1 / 30;
    const expectedDecayRoot = Math.exp(-dt / 1.0);
    const expectedRiseRoot = Math.exp(-dt / 0.01);

    expect(result.dt).toBeCloseTo(dt, 10);
    expect(result.decayRoot).toBeCloseTo(expectedDecayRoot, 10);
    expect(result.riseRoot).toBeCloseTo(expectedRiseRoot, 10);
    expect(result.g1).toBeCloseTo(expectedDecayRoot + expectedRiseRoot, 10);
    expect(result.g2).toBeCloseTo(-(expectedDecayRoot * expectedRiseRoot), 10);
  });

  it('computes dt = 1/fs', () => {
    const result = computeAR2(0.01, 1.0, 100);
    expect(result.dt).toBeCloseTo(0.01, 10);
  });

  it('computes g1 = decayRoot + riseRoot', () => {
    const result = computeAR2(0.05, 0.5, 30);
    expect(result.g1).toBeCloseTo(result.decayRoot + result.riseRoot, 10);
  });

  it('computes g2 = -(decayRoot * riseRoot)', () => {
    const result = computeAR2(0.05, 0.5, 30);
    expect(result.g2).toBeCloseTo(-(result.decayRoot * result.riseRoot), 10);
  });

  it('higher tauDecay produces decayRoot closer to 1', () => {
    const low = computeAR2(0.01, 0.5, 30);
    const high = computeAR2(0.01, 2.0, 30);
    expect(high.decayRoot).toBeGreaterThan(low.decayRoot);
    expect(high.decayRoot).toBeLessThan(1);
  });

  it('higher fs produces roots closer to 1', () => {
    const lowFs = computeAR2(0.01, 1.0, 10);
    const highFs = computeAR2(0.01, 1.0, 1000);
    expect(highFs.decayRoot).toBeGreaterThan(lowFs.decayRoot);
    expect(highFs.riseRoot).toBeGreaterThan(lowFs.riseRoot);
  });

  it('all roots are in (0, 1) range for valid parameters', () => {
    const result = computeAR2(0.01, 1.0, 30);
    expect(result.decayRoot).toBeGreaterThan(0);
    expect(result.decayRoot).toBeLessThan(1);
    expect(result.riseRoot).toBeGreaterThan(0);
    expect(result.riseRoot).toBeLessThan(1);
  });

  it('equal tau values produce equal roots', () => {
    const result = computeAR2(0.5, 0.5, 30);
    expect(result.decayRoot).toBeCloseTo(result.riseRoot, 10);
  });
});
