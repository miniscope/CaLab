/**
 * Double-exponential calcium kernel computation.
 * h(t) = exp(-t/tauDecay) - exp(-t/tauRise), normalized to peak = 1.
 */

/**
 * Compute a double-exponential calcium impulse response kernel.
 *
 * @param tauRise - Rise time constant in seconds (e.g., 0.02)
 * @param tauDecay - Decay time constant in seconds (e.g., 0.4)
 * @param fs - Sampling rate in Hz (e.g., 30)
 * @param durationMultiple - Multiple of tauDecay for kernel duration (default 5)
 * @returns Object with x (time in seconds) and y (kernel amplitude) as number[]
 */
export function computeKernel(
  tauRise: number,
  tauDecay: number,
  fs: number,
  durationMultiple: number = 5,
): { x: number[]; y: number[] } {
  const dt = 1 / fs;
  const duration = durationMultiple * tauDecay;
  const numPoints = Math.ceil(duration * fs);

  const x: number[] = new Array(numPoints);
  const y: number[] = new Array(numPoints);

  for (let i = 0; i < numPoints; i++) {
    const t = i * dt;
    x[i] = t;
    y[i] = Math.exp(-t / tauDecay) - Math.exp(-t / tauRise);
  }

  // Normalize to peak = 1
  let peak = 0;
  for (let i = 0; i < numPoints; i++) {
    if (y[i] > peak) peak = y[i];
  }
  if (peak > 0) {
    for (let i = 0; i < numPoints; i++) {
      y[i] /= peak;
    }
  }

  return { x, y };
}

/**
 * Compute annotation positions for the kernel chart.
 *
 * @param tauRise - Rise time constant in seconds
 * @param tauDecay - Decay time constant in seconds
 * @param fs - Sampling rate in Hz
 * @returns Peak time and half-decay time in seconds, or null if degenerate
 */
export function computeKernelAnnotations(
  tauRise: number,
  tauDecay: number,
  fs: number,
): { peakTime: number; halfDecayTime: number } | null {
  if (tauDecay <= tauRise || tauRise <= 0 || tauDecay <= 0) return null;

  // Analytical peak time: t_peak = (τ_r × τ_d) / (τ_d - τ_r) × ln(τ_d / τ_r)
  const peakTime = ((tauRise * tauDecay) / (tauDecay - tauRise)) * Math.log(tauDecay / tauRise);

  // Numerical search for half-decay: first sample after peak where kernel ≤ 0.5
  const dt = 1 / fs;
  const peakSample = Math.round(peakTime * fs);
  const maxSamples = Math.ceil(5 * tauDecay * fs);

  // Compute kernel value at peak for normalization
  const peakVal = Math.exp(-peakTime / tauDecay) - Math.exp(-peakTime / tauRise);
  if (peakVal <= 0) return null;

  for (let i = peakSample + 1; i < maxSamples; i++) {
    const t = i * dt;
    const val = (Math.exp(-t / tauDecay) - Math.exp(-t / tauRise)) / peakVal;
    if (val <= 0.5) {
      return { peakTime, halfDecayTime: t };
    }
  }

  return null;
}
