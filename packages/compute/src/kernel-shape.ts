/**
 * Conversion between (tauRise, tauDecay) and (tPeak, fwhm) parameterizations
 * of the bi-exponential calcium kernel h(t) = exp(-t/τ_d) - exp(-t/τ_r).
 *
 * The ratio k = τ_d / τ_r fully determines the kernel shape (up to scaling).
 * FWHM/tPeak depends only on k, enabling a precomputed lookup table
 * for microsecond-level inverse conversion (shape → tau).
 */

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Bisect for x where fn(x) = target. fn must be monotonically increasing on [lo, hi]. */
function bisectIncreasing(
  fn: (x: number) => number,
  lo: number,
  hi: number,
  target: number,
  tol: number = 1e-10,
  maxIter: number = 60,
): number {
  for (let i = 0; i < maxIter; i++) {
    const mid = (lo + hi) / 2;
    if (fn(mid) < target) lo = mid;
    else hi = mid;
    if (hi - lo < tol) break;
  }
  return (lo + hi) / 2;
}

/** Unnormalized kernel value at normalized time u for ratio k = τ_d/τ_r. */
function kernelAtU(u: number, k: number): number {
  return Math.exp(-u / k) - Math.exp(-u);
}

/** Peak time in normalized coordinates (u = t / τ_r). */
function normalizedPeakTime(k: number): number {
  return (k / (k - 1)) * Math.log(k);
}

/**
 * Compute the FWHM / tPeak ratio for a given k = τ_d / τ_r.
 * Uses bisection on the normalized kernel (depends only on k).
 */
function computeRatioForK(k: number): number {
  const uPeak = normalizedPeakTime(k);
  const hPeak = kernelAtU(uPeak, k);
  if (hPeak <= 0) return NaN;
  const halfMax = hPeak / 2;

  // Rising half-max: kernel is increasing on [0, uPeak]
  const uHalfRise = bisectIncreasing((u) => kernelAtU(u, k), 0, uPeak, halfMax);

  // Falling half-max: kernel is decreasing on [uPeak, 5k]
  // Negate to make it increasing for the bisection
  const uHalfDecay = bisectIncreasing((u) => -kernelAtU(u, k), uPeak, 5 * k, -halfMax);

  return (uHalfDecay - uHalfRise) / uPeak;
}

// ---------------------------------------------------------------------------
// Lookup table (lazy-initialized, ~300 entries, log-spaced in k)
// ---------------------------------------------------------------------------

interface LookupEntry {
  k: number;
  ratio: number; // FWHM / tPeak
}

const TABLE_SIZE = 300;
const K_MIN = 1.001;
const K_MAX = 10000;

let lookupTable: LookupEntry[] | null = null;

function ensureLookupTable(): LookupEntry[] {
  if (lookupTable) return lookupTable;

  const table: LookupEntry[] = new Array(TABLE_SIZE);
  const logMin = Math.log(K_MIN);
  const logMax = Math.log(K_MAX);

  for (let i = 0; i < TABLE_SIZE; i++) {
    const logK = logMin + (i / (TABLE_SIZE - 1)) * (logMax - logMin);
    const k = Math.exp(logK);
    table[i] = { k, ratio: computeRatioForK(k) };
  }

  lookupTable = table;
  return table;
}

/** Interpolate the lookup table to find k given a FWHM/tPeak ratio. */
function interpolateK(ratio: number): number | null {
  const table = ensureLookupTable();

  if (ratio < table[0].ratio || ratio > table[TABLE_SIZE - 1].ratio) return null;

  // Binary search for the bracketing interval
  let lo = 0;
  let hi = TABLE_SIZE - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (table[mid].ratio <= ratio) lo = mid;
    else hi = mid;
  }

  // Linear interpolation in log-k space for better accuracy
  const t = (ratio - table[lo].ratio) / (table[hi].ratio - table[lo].ratio);
  const logK = Math.log(table[lo].k) + t * (Math.log(table[hi].k) - Math.log(table[lo].k));
  return Math.exp(logK);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert (tauRise, tauDecay) to (tPeak, fwhm).
 * Peak time is analytical; FWHM uses bisection for half-max points.
 * All values in seconds.
 */
export function tauToShape(
  tauRise: number,
  tauDecay: number,
): { tPeak: number; fwhm: number } | null {
  if (tauDecay <= tauRise || tauRise <= 0 || tauDecay <= 0) return null;

  // Analytical peak time: t_peak = (τ_r × τ_d) / (τ_d - τ_r) × ln(τ_d / τ_r)
  const tPeak = ((tauRise * tauDecay) / (tauDecay - tauRise)) * Math.log(tauDecay / tauRise);

  // Kernel value at peak for normalization
  const peakVal = Math.exp(-tPeak / tauDecay) - Math.exp(-tPeak / tauRise);
  if (peakVal <= 0) return null;
  const halfMax = peakVal / 2;

  const kernel = (t: number) => Math.exp(-t / tauDecay) - Math.exp(-t / tauRise);

  // Rising half-max: kernel is increasing on [0, tPeak]
  const tHalfRise = bisectIncreasing(kernel, 0, tPeak, halfMax);

  // Falling half-max: kernel is decreasing on [tPeak, 5*tauDecay]
  const tHalfDecay = bisectIncreasing((t) => -kernel(t), tPeak, 5 * tauDecay, -halfMax);

  return { tPeak, fwhm: tHalfDecay - tHalfRise };
}

/**
 * Convert (tPeak, fwhm) to (tauRise, tauDecay) via k-ratio lookup table.
 * All values in seconds. Returns null if the pair is outside valid range.
 */
export function shapeToTau(
  tPeak: number,
  fwhm: number,
): { tauRise: number; tauDecay: number } | null {
  if (tPeak <= 0 || fwhm <= 0 || fwhm <= tPeak) return null;

  const ratio = fwhm / tPeak;
  const k = interpolateK(ratio);
  if (k == null) return null;

  const tauRise = (tPeak * (k - 1)) / (k * Math.log(k));
  const tauDecay = k * tauRise;

  if (!isFinite(tauRise) || !isFinite(tauDecay) || tauRise <= 0 || tauDecay <= 0) return null;

  return { tauRise, tauDecay };
}

/** Compute FWHM for a given (tauRise, tauDecay) pair. Returns seconds or null. */
export function computeFWHM(tauRise: number, tauDecay: number): number | null {
  return tauToShape(tauRise, tauDecay)?.fwhm ?? null;
}
