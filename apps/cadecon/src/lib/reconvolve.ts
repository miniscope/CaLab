/**
 * Reconvolve a spike train through the peak-normalized AR2 forward model.
 * Mirrors the Rust BandedAR2 convolution: c[t] = g1*c[t-1] + g2*c[t-2] + s[t],
 * then normalize by impulse peak so recon = alpha * (c / peak) + baseline.
 */
export function reconvolveAR2(
  sCounts: Float32Array,
  tauR: number,
  tauD: number,
  fs: number,
  alpha: number,
  baseline: number,
): Float32Array {
  const dt = 1 / fs;
  const d = Math.exp(-dt / tauD);
  const r = Math.exp(-dt / tauR);
  const g1 = d + r;
  const g2 = -(d * r);

  // Compute impulse peak (same logic as Rust compute_impulse_peak)
  let impPeak = 1.0;
  let cPrev2 = 0;
  let cPrev1 = 1;
  const maxSteps = Math.ceil(5 * tauD * fs) + 10;
  for (let i = 1; i < maxSteps; i++) {
    const cv = g1 * cPrev1 + g2 * cPrev2;
    if (cv > impPeak) impPeak = cv;
    if (cv < impPeak * 0.95) break;
    cPrev2 = cPrev1;
    cPrev1 = cv;
  }

  const n = sCounts.length;
  const reconvolved = new Float32Array(n);
  const c = new Float64Array(n);
  for (let t = 0; t < n; t++) {
    c[t] = sCounts[t] + (t >= 1 ? g1 * c[t - 1] : 0) + (t >= 2 ? g2 * c[t - 2] : 0);
    reconvolved[t] = alpha * (c[t] / impPeak) + baseline;
  }
  return reconvolved;
}
