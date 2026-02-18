/**
 * Realistic synthetic calcium trace generator.
 *
 * Pipeline: Markov chain spike train → convolve with calcium kernel → add noise.
 * Produces traces that resemble real calcium imaging data for development and testing.
 */

import { computeKernel } from './kernel-math.ts';
import type { MarkovParams, NoiseParams, SimulationParams } from './demo-presets.ts';

/** Neuronal spike simulation rate — 3.3ms refractory period. */
const SPIKE_SIM_HZ = 300;

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
  simParams?: { markov?: MarkovParams; noise?: NoiseParams },
): { raw: Float64Array; spikes: Float64Array; clean: Float64Array } {
  const rng = createRng(seed);

  // --- High-resolution Markov chain spike generation at SPIKE_SIM_HZ ---
  const binsPerFrame = Math.round(SPIKE_SIM_HZ / fs);
  const numHighResPoints = numTimepoints * binsPerFrame;

  // Scale transition probabilities for high-res timestep so per-frame rate matches
  const pBaseS2A = simParams?.markov?.pSilentToActive ?? 0.02;
  const pBaseA2S = simParams?.markov?.pActiveToSilent ?? 0.15;
  const pSilentToActive = 1 - Math.pow(1 - pBaseS2A, 1 / binsPerFrame);
  const pActiveToSilent = 1 - Math.pow(1 - pBaseA2S, 1 / binsPerFrame);
  const pSpikeWhenActive = simParams?.markov?.pSpikeWhenActive ?? 0.7;
  const pSpikeWhenSilent = simParams?.markov?.pSpikeWhenSilent ?? 0.005;

  // Generate binary spike train at 300 Hz
  const highResSpikes = new Uint8Array(numHighResPoints);
  let state = 0; // start silent

  for (let i = 0; i < numHighResPoints; i++) {
    if (state === 0) {
      if (rng.next() < pSilentToActive) state = 1;
    } else {
      if (rng.next() < pActiveToSilent) state = 0;
    }

    const pSpike = state === 1 ? pSpikeWhenActive : pSpikeWhenSilent;
    if (rng.next() < pSpike) {
      highResSpikes[i] = 1;
    }
  }

  // Bin to imaging FPS: count spikes per frame, apply log-normal amplitude
  const spikes = new Float64Array(numTimepoints);
  for (let f = 0; f < numTimepoints; f++) {
    let count = 0;
    const start = f * binsPerFrame;
    const end = start + binsPerFrame;
    for (let j = start; j < end; j++) {
      count += highResSpikes[j];
    }
    if (count > 0) {
      // Amplitude: log-normal distributed (mean ~1, occasional large transients)
      spikes[f] = count * Math.exp((simParams?.noise?.amplitudeSigma ?? 0.3) * rng.gaussian());
    }
  }

  // --- Convolve with calcium kernel at imaging FPS ---
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
  const cyclesMin = simParams?.noise?.driftCyclesMin ?? 2;
  const cyclesMax = simParams?.noise?.driftCyclesMax ?? 4;
  const driftPeriod = numTimepoints / (cyclesMin + rng.next() * (cyclesMax - cyclesMin));
  const driftAmp = simParams?.noise?.driftAmplitude ?? 0.1;

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
  simParams: SimulationParams,
  fs: number = 30,
  baseSeed: number = 42,
): {
  data: Float64Array;
  shape: [number, number];
  groundTruthSpikes: Float64Array;
  groundTruthCalcium: Float64Array;
} {
  const data = new Float64Array(numCells * numTimepoints);
  const groundTruthSpikes = new Float64Array(numCells * numTimepoints);
  const groundTruthCalcium = new Float64Array(numCells * numTimepoints);

  for (let c = 0; c < numCells; c++) {
    const { raw, spikes, clean } = generateSyntheticTrace(
      numTimepoints,
      simParams.tauRise,
      simParams.tauDecay,
      fs,
      baseSeed + c * 7919, // different prime-offset seed per cell
      simParams.snrBase + (c % 5) * simParams.snrStep,
      { markov: simParams.markov, noise: simParams.noise },
    );
    const offset = c * numTimepoints;
    data.set(raw, offset);
    groundTruthSpikes.set(spikes, offset);
    groundTruthCalcium.set(clean, offset);
  }

  return { data, shape: [numCells, numTimepoints], groundTruthSpikes, groundTruthCalcium };
}
