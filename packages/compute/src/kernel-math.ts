/**
 * Double-exponential calcium kernel computation.
 * h(t) = exp(-t/tauDecay) - exp(-t/tauRise), normalized to peak = 1.
 */

/** Kernel duration as a multiple of tauDecay (e^-5 ≈ 0.7% of peak remains). */
export const KERNEL_DURATION_MULTIPLE = 5;

/** Floor on the convergence-RMSE grid sample count (see kernelShapeRmse). */
export const KERNEL_RMSE_MIN_SAMPLES = 24;

/**
 * Sample a peak-normalized double-exponential kernel h(t)=exp(-t/τ_d)-exp(-t/τ_r)
 * onto `n` points at spacing `dt`, normalized to its sampled peak of 1. The
 * shared sampling primitive behind both computeKernel and kernelShapeRmse.
 */
export function sampleBiexp(tauRise: number, tauDecay: number, n: number, dt: number): number[] {
  const y = new Array<number>(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const t = i * dt;
    const v = Math.exp(-t / tauDecay) - Math.exp(-t / tauRise);
    y[i] = v;
    if (v > peak) peak = v;
  }
  if (peak > 0) {
    for (let i = 0; i < n; i++) y[i] /= peak;
  }
  return y;
}

/**
 * Compute a double-exponential calcium impulse response kernel.
 *
 * @param tauRise - Rise time constant in seconds (e.g., 0.02)
 * @param tauDecay - Decay time constant in seconds (e.g., 0.4)
 * @param fs - Sampling rate in Hz (e.g., 30)
 * @param durationMultiple - Multiple of tauDecay for kernel duration
 * @returns Object with x (time in seconds) and y (kernel amplitude) as number[]
 */
export function computeKernel(
  tauRise: number,
  tauDecay: number,
  fs: number,
  durationMultiple: number = KERNEL_DURATION_MULTIPLE,
): { x: number[]; y: number[] } {
  const dt = 1 / fs;
  const numPoints = Math.ceil(durationMultiple * tauDecay * fs);
  const y = sampleBiexp(tauRise, tauDecay, numPoints, dt);
  const x: number[] = new Array(numPoints);
  for (let i = 0; i < numPoints; i++) x[i] = i * dt;
  return { x, y };
}

/**
 * Convergence metric: peak-normalized RMSE between two bi-exponential kernels.
 *
 * Both kernels are sampled on a shared grid spanning [0, 5·max(τ_d)] — the `max`
 * guarantees neither decay tail is truncated when τ_decay changes between
 * iterations — at the native sampling rate (grid spacing ≈ 1/fs), floored to
 * KERNEL_RMSE_MIN_SAMPLES points so a low fs / fast kernel doesn't reduce it to a
 * handful of samples. Each is normalized to peak 1, so the result is a fraction
 * of peak: 0 = identical, ~0.01 ≈ a 1%-of-peak typical deviation.
 *
 * Measuring the whole waveform (rather than a relative (t_peak, FWHM) delta)
 * weights each parameter's change by how much it actually moves the kernel, so a
 * jittery t_peak on the poorly-constrained rising edge no longer delays
 * convergence over a change that barely alters the shape.
 */
export function kernelShapeRmse(
  tauR1: number,
  tauD1: number,
  tauR2: number,
  tauD2: number,
  fs: number,
): number {
  const window = KERNEL_DURATION_MULTIPLE * Math.max(tauD1, tauD2);
  const n = Math.max(KERNEL_RMSE_MIN_SAMPLES, Math.ceil(window * fs));
  const dt = window / n;
  const k1 = sampleBiexp(tauR1, tauD1, n, dt);
  const k2 = sampleBiexp(tauR2, tauD2, n, dt);
  let s = 0;
  for (let i = 0; i < n; i++) {
    const d = k1[i] - k2[i];
    s += d * d;
  }
  return Math.sqrt(s / n);
}

/**
 * Compute annotation positions for the kernel chart.
 *
 * @param tauRise - Rise time constant in seconds
 * @param tauDecay - Decay time constant in seconds
 * @param fs - Sampling rate in Hz
 * @returns Peak time, half-decay time, half-rise time, and FWHM in seconds, or null if degenerate
 */
export function computeKernelAnnotations(
  tauRise: number,
  tauDecay: number,
  fs: number,
): { peakTime: number; halfDecayTime: number; halfRiseTime: number; fwhm: number } | null {
  if (tauDecay <= tauRise || tauRise <= 0 || tauDecay <= 0) return null;

  // Analytical peak time: t_peak = (τ_r × τ_d) / (τ_d - τ_r) × ln(τ_d / τ_r)
  const peakTime = ((tauRise * tauDecay) / (tauDecay - tauRise)) * Math.log(tauDecay / tauRise);

  const dt = 1 / fs;
  const peakSample = Math.round(peakTime * fs);
  const maxSamples = Math.ceil(5 * tauDecay * fs);

  // Compute kernel value at peak for normalization
  const peakVal = Math.exp(-peakTime / tauDecay) - Math.exp(-peakTime / tauRise);
  if (peakVal <= 0) return null;

  // Rising half-max bisection: search on [0, peakTime] for first sample where kernel >= 0.5
  let halfRiseTime: number | null = null;
  for (let i = 0; i <= peakSample; i++) {
    const t = i * dt;
    const val = (Math.exp(-t / tauDecay) - Math.exp(-t / tauRise)) / peakVal;
    if (val >= 0.5) {
      halfRiseTime = t;
      break;
    }
  }
  if (halfRiseTime == null) return null;

  // Numerical search for half-decay: first sample after peak where kernel <= 0.5
  let halfDecayTime: number | null = null;
  for (let i = peakSample + 1; i < maxSamples; i++) {
    const t = i * dt;
    const val = (Math.exp(-t / tauDecay) - Math.exp(-t / tauRise)) / peakVal;
    if (val <= 0.5) {
      halfDecayTime = t;
      break;
    }
  }
  if (halfDecayTime == null) return null;

  const fwhm = halfDecayTime - halfRiseTime;
  return { peakTime, halfDecayTime, halfRiseTime, fwhm };
}
