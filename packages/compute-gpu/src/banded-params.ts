/**
 * Pure TypeScript port of the banded-AR(2) parameter math in the Rust solver.
 *
 * Mirrors, in f64:
 *   - `clamp_tau_rise` and `build_kernel` (crates/solver/src/kernel.rs), used
 *     only for `kernel_dc_gain = sum(build_kernel(...))`, which scales lambda
 *     (`effective_lambda`, crates/solver/src/lib.rs).
 *   - `BandedAR2::new`, `compute_impulse_peak` and `compute_banded_lipschitz`
 *     (crates/solver/src/banded.rs).
 *
 * The recursion coefficients are f64 on the host and cast to f32 for the
 * recursion, exactly as Rust does. The GPU runs the AR(2) as two cascaded
 * first-order filters with roots (d, r); `decayRootF32`/`riseRootF32` are the
 * roots of the f32-rounded polynomial z^2 - g1f*z - g2f, so the cascade
 * reproduces the operator the Rust recursion actually applies.
 */
import { computeAR2 } from '@calab/core';

/** Clamp tau_rise away from tau_decay (port of `clamp_tau_rise`). */
export function clampTauRise(tauRise: number, tauDecay: number): number {
  if (Math.abs(tauRise - tauDecay) < 1e-6 * Math.max(tauDecay, tauRise, 1e-12)) {
    return tauDecay * 0.5;
  }
  return tauRise;
}

/** Port of `build_kernel`: f64 bi-exponential normalized to peak 1, cast to f32. */
export function buildKernel(tauRise: number, tauDecay: number, fs: number): Float32Array {
  const tr = clampTauRise(tauRise, tauDecay);
  const dt = 1 / fs;
  const len = Math.max(Math.ceil((-Math.log(1e-6) * tauDecay) / dt), 2);
  const k64 = new Float64Array(len);
  let peak = 0;
  for (let i = 0; i < len; i++) {
    const t = i * dt;
    const v = Math.exp(-t / tauDecay) - Math.exp(-t / tr);
    k64[i] = v;
    if (v > peak) peak = v;
  }
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) out[i] = peak > 0 ? k64[i] / peak : k64[i];
  return out;
}

/** `kernel_dc_gain`: sum of the f32 kernel taps, accumulated in f64. */
export function kernelDcGain(tauRise: number, tauDecay: number, fs: number): number {
  const k = buildKernel(tauRise, tauDecay, fs);
  let s = 0;
  for (let i = 0; i < k.length; i++) s += k[i];
  return s;
}

/** Port of `compute_impulse_peak`. */
export function computeImpulsePeak(g1: number, g2: number, tauDecay: number, fs: number): number {
  const maxSteps = Math.ceil(5 * tauDecay * fs) + 10;
  let cPrev2 = 0;
  let cPrev1 = 1;
  let peak = 1;
  for (let i = 1; i < maxSteps; i++) {
    const c = g1 * cPrev1 + g2 * cPrev2;
    if (c > peak) peak = c;
    if (c < peak * 0.95) break;
    cPrev2 = cPrev1;
    cPrev1 = c;
  }
  return Math.max(peak, 1);
}

/** Port of `compute_banded_lipschitz` (4096-point frequency grid). */
export function computeBandedLipschitz(g1: number, g2: number): number {
  const nFreqs = 4096;
  let maxPower = 0;
  for (let k = 0; k <= nFreqs; k++) {
    const w = (Math.PI * k) / nFreqs;
    const cw = Math.cos(w);
    const sw = Math.sin(w);
    const c2w = 2 * cw * cw - 1;
    const s2w = 2 * sw * cw;
    const re = 1 - g1 * cw - g2 * c2w;
    const im = g1 * sw + g2 * s2w;
    const denomSq = re * re + im * im;
    if (denomSq > 1e-30) maxPower = Math.max(maxPower, 1 / denomSq);
  }
  return Math.max(maxPower, 1e-10);
}

export interface BandedParams {
  /** f64 AR(2) coefficients (g1 = d + r, g2 = -d*r). */
  g1: number;
  g2: number;
  /** The same coefficients rounded to f32, as the Rust recursion uses them. */
  g1F32: number;
  g2F32: number;
  /** Roots of the f32 polynomial; the cascade coefficients used on the GPU. */
  decayRootF32: number;
  riseRootF32: number;
  impulsePeak: number;
  invPeakF32: number;
  /** Lipschitz constant of the peak-normalized operator: L_raw / peak^2. */
  lipschitz: number;
  kernelDcGain: number;
  /** step = 1/L and thresh = step * lambda * kernelDcGain, f64 then f32. */
  stepF32: number;
  threshF32: number;
}

export function computeBandedParams(
  tauRise: number,
  tauDecay: number,
  fs: number,
  lambda: number,
): BandedParams {
  const tr = clampTauRise(tauRise, tauDecay);
  const { g1, g2, decayRoot, riseRoot } = computeAR2(tr, tauDecay, fs);
  const impulsePeak = computeImpulsePeak(g1, g2, tauDecay, fs);
  const lipschitz = computeBandedLipschitz(g1, g2) / (impulsePeak * impulsePeak);
  const g1F32 = Math.fround(g1);
  const g2F32 = Math.fround(g2);

  // Roots of z^2 - g1f z - g2f = 0. The larger root via the quadratic formula,
  // the smaller via Vieta (product = -g2f) to avoid cancellation.
  const disc = g1F32 * g1F32 + 4 * g2F32;
  let big = decayRoot;
  let small = riseRoot;
  if (disc >= 0) {
    big = (g1F32 + Math.sqrt(disc)) / 2;
    small = big !== 0 ? -g2F32 / big : 0;
  }

  const dc = kernelDcGain(tauRise, tauDecay, fs);
  const step = 1 / lipschitz;
  const thresh = step * lambda * dc;
  return {
    g1,
    g2,
    g1F32,
    g2F32,
    decayRootF32: Math.fround(big),
    riseRootF32: Math.fround(small),
    impulsePeak,
    invPeakF32: Math.fround(1 / impulsePeak),
    lipschitz,
    kernelDcGain: dc,
    stepF32: Math.fround(step),
    threshF32: Math.fround(thresh),
  };
}
