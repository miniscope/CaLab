import { describe, it, expect } from 'vitest';
import { validateSubmission } from '../quality-checks.ts';

/** Helper that returns a valid baseline parameter set. */
function validParams() {
  return { tauRise: 0.05, tauDecay: 0.5, lambda: 0.01, samplingRate: 30 };
}

describe('validateSubmission', () => {
  it('accepts valid params', () => {
    const result = validateSubmission(validParams());
    expect(result).toEqual({ valid: true, issues: [] });
  });

  it('accepts tauRise at exact min boundary (0.001)', () => {
    const result = validateSubmission({ ...validParams(), tauRise: 0.001 });
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('accepts tauRise at exact max boundary (0.5)', () => {
    // tauDecay must be greater than tauRise, so bump it up
    const result = validateSubmission({ ...validParams(), tauRise: 0.5, tauDecay: 1.0 });
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('rejects tauRise below min (0.0001)', () => {
    const result = validateSubmission({ ...validParams(), tauRise: 0.0001 });
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([expect.stringContaining('tau_rise')]));
  });

  it('rejects tauDecay above max (11)', () => {
    const result = validateSubmission({ ...validParams(), tauDecay: 11 });
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([expect.stringContaining('tau_decay')]));
  });

  it('rejects lambda below min (0)', () => {
    const result = validateSubmission({ ...validParams(), lambda: 0 });
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([expect.stringContaining('lambda')]));
  });

  it('rejects samplingRate above max (1001)', () => {
    const result = validateSubmission({ ...validParams(), samplingRate: 1001 });
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([expect.stringContaining('sampling_rate')]),
    );
  });

  it('rejects tauRise >= tauDecay', () => {
    const result = validateSubmission({ ...validParams(), tauRise: 0.5, tauDecay: 0.5 });
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([expect.stringContaining('must be less than')]),
    );
  });

  it('collects multiple violations in the issues array', () => {
    const result = validateSubmission({
      tauRise: 999,
      tauDecay: 0.001,
      lambda: 0,
      samplingRate: 9999,
    });
    expect(result.valid).toBe(false);
    // At least tau_rise, tau_decay, lambda, sampling_rate, and tau_rise >= tau_decay
    expect(result.issues.length).toBeGreaterThanOrEqual(4);
  });
});
