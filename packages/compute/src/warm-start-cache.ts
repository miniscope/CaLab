import type { SolverParams, WarmStartStrategy } from '@catune/core';

/** Number of tau_decay time constants of padding on each side of the visible window. */
const PADDING_TAU_MULTIPLIER = 5;

/** Maximum padding cap: 5 minutes of samples per side. */
const MAX_PADDING_SECONDS = 5 * 60;

/** Relative change threshold below which tau changes use warm-no-momentum. */
const TAU_CHANGE_THRESHOLD = 0.2;

/** Cached warm-start state from a previous solve, keyed by window and params. */
export interface WarmStartEntry {
  state: Uint8Array;
  params: SolverParams;
  paddedStart: number;
  paddedEnd: number;
}

/**
 * Compute the overlap-and-discard padded window for artifact-free windowed computation.
 *
 * Adds >= 5 * tauDecay * fs padding samples on each side of the visible region
 * (per research Pattern 3) to prevent edge artifacts from kernel truncation.
 * The padding is clamped to trace bounds.
 *
 * @returns paddedStart/paddedEnd (solver input range), resultOffset (where visible
 *          region starts in solver output), resultLength (how many samples to extract).
 */
export function computePaddedWindow(
  visibleStart: number,
  visibleEnd: number,
  traceLength: number,
  tauDecay: number,
  fs: number,
): { paddedStart: number; paddedEnd: number; resultOffset: number; resultLength: number } {
  const visibleSamples = visibleEnd - visibleStart;
  const tauPadding = Math.ceil(PADDING_TAU_MULTIPLIER * tauDecay * fs);
  const maxPadding = Math.ceil(MAX_PADDING_SECONDS * fs);
  const paddingSamples = Math.min(Math.max(visibleSamples, tauPadding), maxPadding);
  const paddedStart = Math.max(0, visibleStart - paddingSamples);
  const paddedEnd = Math.min(traceLength, visibleEnd + paddingSamples);
  const resultOffset = visibleStart - paddedStart;
  const resultLength = visibleEnd - visibleStart;

  return { paddedStart, paddedEnd, resultOffset, resultLength };
}

/** Compute the artifact-safe margin in samples (region that may have edge artifacts). */
export function computeSafeMargin(tauDecay: number, fs: number): number {
  return Math.ceil(PADDING_TAU_MULTIPLIER * tauDecay * fs);
}

/**
 * Classify warm-start strategy based on how parameters and window changed.
 *
 * - 'warm': Only lambda changed (same kernel) -- full warm-start, solution is close.
 * - 'warm-no-momentum': Tau changed by < 20% -- kernel changed so momentum direction
 *   is invalid, but solution magnitude is still useful as initial point.
 * - 'cold': Window shifted, tau changed significantly, or no cached state.
 *
 * The 20% threshold is a heuristic from research Pattern 4.
 */
export function shouldWarmStart(
  cached: WarmStartEntry | null,
  newParams: SolverParams,
  newWindowStart: number,
  newWindowEnd: number,
): WarmStartStrategy {
  if (!cached) return 'cold';

  // Window changed -- previous solution is for a different trace region
  if (cached.paddedStart !== newWindowStart || cached.paddedEnd !== newWindowEnd) {
    return 'cold';
  }

  const oldParams = cached.params;

  // Sampling rate or filter state changed -- fundamentally different input
  if (oldParams.fs !== newParams.fs || oldParams.filterEnabled !== newParams.filterEnabled) {
    return 'cold';
  }

  const tauRiseSame = oldParams.tauRise === newParams.tauRise;
  const tauDecaySame = oldParams.tauDecay === newParams.tauDecay;

  // Only lambda changed (same kernel) -- full warm-start
  if (tauRiseSame && tauDecaySame) {
    return 'warm';
  }

  // Tau changed -- check if within 20% relative threshold
  const tauRiseChange =
    oldParams.tauRise > 0
      ? Math.abs(newParams.tauRise - oldParams.tauRise) / oldParams.tauRise
      : newParams.tauRise === 0
        ? 0
        : 1;
  const tauDecayChange =
    oldParams.tauDecay > 0
      ? Math.abs(newParams.tauDecay - oldParams.tauDecay) / oldParams.tauDecay
      : newParams.tauDecay === 0
        ? 0
        : 1;

  if (tauRiseChange < TAU_CHANGE_THRESHOLD && tauDecayChange < TAU_CHANGE_THRESHOLD) {
    return 'warm-no-momentum';
  }

  // Too different -- start fresh
  return 'cold';
}

/**
 * Single-entry cache for warm-start solver state.
 *
 * Only stores the most recent solve result. Multi-entry caching is unnecessary
 * since we always want the most recent state for the current window.
 */
export class WarmStartCache {
  private entry: WarmStartEntry | null = null;

  /** Save the warm-start state from a completed solve. */
  store(state: Uint8Array, params: SolverParams, paddedStart: number, paddedEnd: number): void {
    this.entry = { state, params, paddedStart, paddedEnd };
  }

  /** Get the raw cached entry (or null if empty). */
  get(): WarmStartEntry | null {
    return this.entry;
  }

  /**
   * Get the warm-start strategy and state for a new solve request.
   * Returns the strategy classification and the cached state (or null for cold starts).
   */
  getStrategy(
    newParams: SolverParams,
    newPaddedStart: number,
    newPaddedEnd: number,
  ): { strategy: WarmStartStrategy; state: Uint8Array | null } {
    const strategy = shouldWarmStart(this.entry, newParams, newPaddedStart, newPaddedEnd);
    if (strategy === 'cold') {
      return { strategy, state: null };
    }
    return { strategy, state: this.entry!.state };
  }

  /** Clear the cache. */
  clear(): void {
    this.entry = null;
  }
}
