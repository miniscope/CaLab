import { describe, it, expect } from 'vitest';
import { tauToShape, shapeToTau, computeFWHM, isValidShapePair } from '../kernel-shape.ts';
import { SIMULATION_PRESETS } from '../simulation-presets.ts';

describe('tauToShape', () => {
  it('returns null for degenerate inputs (tauDecay <= tauRise)', () => {
    expect(tauToShape(0.5, 0.5)).toBeNull();
    expect(tauToShape(0.5, 0.1)).toBeNull();
    expect(tauToShape(0, 0.5)).toBeNull();
    expect(tauToShape(-0.1, 0.5)).toBeNull();
  });

  it('computes correct peak time analytically', () => {
    // t_peak = (τ_r × τ_d) / (τ_d - τ_r) × ln(τ_d / τ_r)
    const tauRise = 0.1;
    const tauDecay = 0.6;
    const expected = ((tauRise * tauDecay) / (tauDecay - tauRise)) * Math.log(tauDecay / tauRise);
    const result = tauToShape(tauRise, tauDecay)!;
    expect(result.tPeak).toBeCloseTo(expected, 10);
  });

  it('FWHM is always greater than tPeak', () => {
    const cases = [
      [0.001, 0.05],
      [0.02, 0.4],
      [0.1, 0.6],
      [0.4, 1.8],
      [0.05, 1.5],
    ] as const;
    for (const [tr, td] of cases) {
      const result = tauToShape(tr, td)!;
      expect(result.fwhm).toBeGreaterThan(result.tPeak);
    }
  });

  it('larger tauDecay produces larger FWHM', () => {
    const a = tauToShape(0.1, 0.5)!;
    const b = tauToShape(0.1, 1.0)!;
    expect(b.fwhm).toBeGreaterThan(a.fwhm);
  });
});

describe('shapeToTau', () => {
  it('returns null for invalid inputs', () => {
    expect(shapeToTau(0, 0.5)).toBeNull();
    expect(shapeToTau(0.1, -0.1)).toBeNull();
    expect(shapeToTau(0.5, 0.2)).toBeNull(); // fwhm < tPeak
    expect(shapeToTau(0.5, 0.5)).toBeNull(); // fwhm == tPeak
  });

  it('returns valid tau parameters', () => {
    const result = shapeToTau(0.05, 0.5);
    expect(result).not.toBeNull();
    expect(result!.tauRise).toBeGreaterThan(0);
    expect(result!.tauDecay).toBeGreaterThan(result!.tauRise);
  });
});

describe('round-trip accuracy', () => {
  it('recovers original tau values within 1% for all demo presets', () => {
    for (const preset of SIMULATION_PRESETS) {
      const tauRise = preset.config.kernel.tau_rise_s;
      const tauDecay = preset.config.kernel.tau_decay_s;
      const shape = tauToShape(tauRise, tauDecay);
      expect(shape).not.toBeNull();

      const recovered = shapeToTau(shape!.tPeak, shape!.fwhm);
      expect(recovered).not.toBeNull();

      const riseError = Math.abs(recovered!.tauRise - tauRise) / tauRise;
      const decayError = Math.abs(recovered!.tauDecay - tauDecay) / tauDecay;
      expect(riseError).toBeLessThan(0.01);
      expect(decayError).toBeLessThan(0.01);
    }
  });

  it('round-trips accurately for extreme k ratios', () => {
    const cases = [
      [0.001, 0.005], // k = 5, fast indicator
      [0.001, 3.0], // k = 3000, extreme range
      [0.4, 1.8], // k = 4.5, slow indicator
      [0.03, 0.3], // k = 10, medium
    ] as const;

    for (const [tauRise, tauDecay] of cases) {
      const shape = tauToShape(tauRise, tauDecay)!;
      const recovered = shapeToTau(shape.tPeak, shape.fwhm)!;

      const riseError = Math.abs(recovered.tauRise - tauRise) / tauRise;
      const decayError = Math.abs(recovered.tauDecay - tauDecay) / tauDecay;
      expect(riseError).toBeLessThan(0.01);
      expect(decayError).toBeLessThan(0.01);
    }
  });
});

describe('computeFWHM', () => {
  it('returns a positive number for valid inputs', () => {
    const fwhm = computeFWHM(0.1, 0.6);
    expect(fwhm).toBeGreaterThan(0);
  });

  it('returns null for degenerate inputs', () => {
    expect(computeFWHM(0.5, 0.5)).toBeNull();
  });

  it('agrees with tauToShape', () => {
    const shape = tauToShape(0.1, 0.6)!;
    const fwhm = computeFWHM(0.1, 0.6)!;
    expect(fwhm).toBeCloseTo(shape.fwhm, 10);
  });
});

describe('isValidShapePair', () => {
  it('returns true for valid pairs from demo presets', () => {
    for (const preset of SIMULATION_PRESETS) {
      const shape = tauToShape(preset.config.kernel.tau_rise_s, preset.config.kernel.tau_decay_s)!;
      expect(isValidShapePair(shape.tPeak, shape.fwhm)).toBe(true);
    }
  });

  it('returns false when fwhm <= tPeak', () => {
    expect(isValidShapePair(0.5, 0.2)).toBe(false);
    expect(isValidShapePair(0.5, 0.5)).toBe(false);
  });

  it('returns false for non-positive values', () => {
    expect(isValidShapePair(0, 0.5)).toBe(false);
    expect(isValidShapePair(0.1, 0)).toBe(false);
  });
});

describe('performance', () => {
  it('shapeToTau completes in under 0.5ms per call', () => {
    const shape = tauToShape(0.1, 0.6)!;

    // Warm up the lookup table
    shapeToTau(shape.tPeak, shape.fwhm);

    const iterations = 1000;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      shapeToTau(shape.tPeak, shape.fwhm);
    }
    const elapsed = performance.now() - start;
    const perCall = elapsed / iterations;

    // After lookup table is initialized, each call should be microseconds
    expect(perCall).toBeLessThan(0.5);
  });
});
