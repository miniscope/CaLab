import { describe, it, expect } from 'vitest';
import { computePeriodogram } from '../spectrum/fft.ts';

describe('computePeriodogram', () => {
  it('returns correct output lengths: nfft/2 + 1', () => {
    const signal = new Float64Array(100);
    const fs = 1000;
    const { freqs, psd } = computePeriodogram(signal, fs);
    // nextPow2(100) = 128, so halfN = 128/2 + 1 = 65
    expect(freqs.length).toBe(65);
    expect(psd.length).toBe(65);
  });

  it('frequency axis ends at Nyquist (fs/2)', () => {
    const signal = new Float64Array(64);
    const fs = 1000;
    const { freqs } = computePeriodogram(signal, fs);
    // nextPow2(64) = 64, df = 1000/64 = 15.625
    // last freq = 32 * 15.625 = 500 = fs/2
    expect(freqs[freqs.length - 1]).toBeCloseTo(fs / 2, 5);
  });

  it('first frequency is 0 (DC)', () => {
    const signal = new Float64Array(64);
    const fs = 1000;
    const { freqs } = computePeriodogram(signal, fs);
    expect(freqs[0]).toBe(0);
  });

  it('sinusoid at known frequency has peak at that frequency', () => {
    const fs = 256;
    const N = 256;
    const targetFreq = 32; // Hz
    const signal = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      signal[i] = Math.sin((2 * Math.PI * targetFreq * i) / fs);
    }
    const { freqs, psd } = computePeriodogram(signal, fs);

    // Find the index of the peak PSD value (excluding DC at index 0)
    let peakIdx = 1;
    for (let i = 2; i < psd.length; i++) {
      if (psd[i] > psd[peakIdx]) peakIdx = i;
    }
    expect(freqs[peakIdx]).toBeCloseTo(targetFreq, 0);
  });

  it('power-of-2 length signal works correctly', () => {
    const signal = new Float64Array(64);
    const fs = 100;
    const { freqs, psd } = computePeriodogram(signal, fs);
    // nextPow2(64) = 64, halfN = 33
    expect(freqs.length).toBe(33);
    expect(psd.length).toBe(33);
  });

  it('non-power-of-2 length signal gets zero-padded', () => {
    const signal = new Float64Array(50);
    const fs = 100;
    const { freqs, psd } = computePeriodogram(signal, fs);
    // nextPow2(50) = 64, halfN = 33
    expect(freqs.length).toBe(33);
    expect(psd.length).toBe(33);
  });
});
