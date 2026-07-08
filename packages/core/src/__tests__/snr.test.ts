import { describe, it, expect } from 'vitest';
import { computePeakSNR, snrToQuality } from '../metrics/snr.ts';

describe('computePeakSNR', () => {
  it('returns 0 for short trace (length < 10)', () => {
    const trace = new Float64Array([1, 2, 3, 4, 5]);
    expect(computePeakSNR(trace)).toBe(0);
  });

  it('returns Infinity for flat trace (all same value)', () => {
    const trace = new Float64Array(100).fill(5.0);
    expect(computePeakSNR(trace)).toBe(Infinity);
  });

  it('returns positive SNR for a clear signal trace', () => {
    // Baseline near 0 with some peaks
    const trace = new Float64Array(200);
    for (let i = 0; i < 200; i++) {
      trace[i] = i % 50 < 5 ? 10.0 : 0.1 + Math.random() * 0.01;
    }
    const snr = computePeakSNR(trace);
    expect(snr).toBeGreaterThan(0);
  });

  it('returns Infinity for all-zero trace (zero std)', () => {
    const trace = new Float64Array(100).fill(0);
    expect(computePeakSNR(trace)).toBe(Infinity);
  });

  it('computes a finite SNR when the baseline sits on a large DC offset', () => {
    // Regression for catastrophic cancellation: with a large offset the one-pass
    // variance (E[x^2] - E[x]^2) collapses to ~0 (std 0 → SNR Infinity). The
    // two-pass form recovers the true baseline spread.
    const OFFSET = 1e8;
    const trace = new Float64Array(200);
    for (let i = 0; i < 200; i++) {
      // Baseline with a small, non-degenerate spread; a chunk of clear peaks so
      // the 95th percentile lands on signal, not baseline.
      trace[i] = i < 180 ? OFFSET + ((i % 7) - 3) : OFFSET + 100;
    }
    const snr = computePeakSNR(trace);
    expect(Number.isFinite(snr)).toBe(true);
    expect(snr).toBeGreaterThan(10);
  });
});

describe('snrToQuality', () => {
  it('returns "good" for snr=10', () => {
    expect(snrToQuality(10)).toBe('good');
  });

  it('returns "good" for snr=5.0 (boundary)', () => {
    expect(snrToQuality(5.0)).toBe('good');
  });

  it('returns "fair" for snr=3.0', () => {
    expect(snrToQuality(3.0)).toBe('fair');
  });

  it('returns "fair" for snr=2.0 (boundary)', () => {
    expect(snrToQuality(2.0)).toBe('fair');
  });

  it('returns "poor" for snr=1.0', () => {
    expect(snrToQuality(1.0)).toBe('poor');
  });

  it('returns "poor" for snr=0', () => {
    expect(snrToQuality(0)).toBe('poor');
  });

  it('returns "good" for snr=Infinity', () => {
    expect(snrToQuality(Infinity)).toBe('good');
  });
});
