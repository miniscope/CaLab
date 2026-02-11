/**
 * Realistic synthetic calcium trace generator.
 *
 * Pipeline: Markov chain spike train → convolve with calcium kernel → add noise.
 * Produces traces that resemble real calcium imaging data for development and testing.
 */

import { computeKernel } from './kernel-math';

/** Seeded PRNG (xorshift32) for reproducible synthetic data. */
function createRng(seed: number) {
  let s = seed | 0 || 1;
  return {
    /** Returns uniform [0, 1). */
    next(): number {
      s ^= s << 13;
      s ^= s >> 17;
      s ^= s << 5;
      return (s >>> 0) / 4294967296;
    },
    /** Returns standard normal via Box-Muller. */
    gaussian(): number {
      const u1 = this.next() || 1e-10;
      const u2 = this.next();
      return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    },
  };
}

/**
 * Generate a realistic synthetic calcium trace.
 *
 * 1. Markov chain spike train: two-state (silent/active) with transition
 *    probabilities producing bursty firing patterns.
 * 2. Convolve spike train with double-exponential calcium kernel.
 * 3. Add baseline drift (slow sinusoid) and Gaussian noise.
 *
 * @param numTimepoints - Length of trace to generate
 * @param tauRise - Rise time constant in seconds
 * @param tauDecay - Decay time constant in seconds
 * @param fs - Sampling rate in Hz
 * @param seed - RNG seed for reproducibility (default 42)
 * @param snr - Signal-to-noise ratio (default 8)
 * @returns Object with raw (noisy fluorescence), spikes (ground truth), and clean (noiseless convolution)
 */
export function generateSyntheticTrace(
  numTimepoints: number,
  tauRise: number,
  tauDecay: number,
  fs: number,
  seed: number = 42,
  snr: number = 8,
): { raw: Float64Array; spikes: Float64Array; clean: Float64Array } {
  const rng = createRng(seed);

  // --- Markov chain spike generation ---
  // Two states: 0 = silent, 1 = active (bursting)
  // Transition probabilities per timestep
  const dt = 1 / fs;
  const pSilentToActive = 0.02 * dt * fs; // ~2% chance per frame to start bursting
  const pActiveToSilent = 0.15 * dt * fs; // bursts last ~6-7 frames on average
  const pSpikeWhenActive = 0.7; // high spike probability during burst
  const pSpikeWhenSilent = 0.005; // rare isolated spikes

  const spikes = new Float64Array(numTimepoints);
  let state = 0; // start silent

  for (let i = 0; i < numTimepoints; i++) {
    // State transition
    if (state === 0) {
      if (rng.next() < pSilentToActive) state = 1;
    } else {
      if (rng.next() < pActiveToSilent) state = 0;
    }

    // Spike generation with variable amplitude
    const pSpike = state === 1 ? pSpikeWhenActive : pSpikeWhenSilent;
    if (rng.next() < pSpike) {
      // Amplitude: log-normal distributed (mean ~1, occasional large transients)
      spikes[i] = Math.exp(0.3 * rng.gaussian());
    }
  }

  // --- Convolve with calcium kernel ---
  const kernel = computeKernel(tauRise, tauDecay, fs);
  const kernelY = kernel.y;
  const kLen = kernelY.length;

  const clean = new Float64Array(numTimepoints);
  for (let t = 0; t < numTimepoints; t++) {
    let sum = 0;
    const jMax = Math.min(kLen, t + 1);
    for (let k = 0; k < jMax; k++) {
      sum += spikes[t - k] * kernelY[k];
    }
    clean[t] = sum;
  }

  // --- Add baseline drift + noise ---
  // Slow baseline drift (mimics photobleaching / motion artifacts)
  const driftPeriod = numTimepoints / (2 + rng.next() * 2); // 2-4 slow cycles
  const driftAmp = 0.1; // 10% of signal range

  // Compute signal amplitude for noise scaling
  let signalMax = 0;
  for (let i = 0; i < numTimepoints; i++) {
    if (clean[i] > signalMax) signalMax = clean[i];
  }
  const noiseStd = signalMax / snr;

  const raw = new Float64Array(numTimepoints);
  for (let i = 0; i < numTimepoints; i++) {
    const drift = driftAmp * signalMax * Math.sin((2 * Math.PI * i) / driftPeriod);
    const noise = noiseStd * rng.gaussian();
    raw[i] = clean[i] + drift + noise;
  }

  return { raw, spikes, clean };
}

/**
 * Generate multiple synthetic traces with different seeds (simulating multiple cells).
 * Returns a flat Float64Array in row-major [cells, timepoints] layout, matching .npy format.
 */
export function generateSyntheticDataset(
  numCells: number,
  numTimepoints: number,
  tauRise: number = 0.02,
  tauDecay: number = 0.4,
  fs: number = 30,
  baseSeed: number = 42,
): { data: Float64Array; shape: [number, number] } {
  const data = new Float64Array(numCells * numTimepoints);

  for (let c = 0; c < numCells; c++) {
    const { raw } = generateSyntheticTrace(
      numTimepoints,
      tauRise,
      tauDecay,
      fs,
      baseSeed + c * 7919, // different prime-offset seed per cell
      20 + (c % 5) * 2, // varying SNR across cells (6-14)
    );
    data.set(raw, c * numTimepoints);
  }

  return { data, shape: [numCells, numTimepoints] };
}
