/**
 * `?factors` (experimental; slice 2 of
 * docs/superpowers/specs/2026-11-23-cala-factors-on-settle-design.md): a
 * live stream's Final settle and Extract read the factors Discover wrote
 * during the stream. A recording with `?factors` is a `?compress` run until
 * slice 3.
 */
import type { CompressTiling } from '../workers/compress-types.ts';

/** The tiling a factor run compresses on (two offset grids: no tile-line jump). */
export const FACTOR_TILING: CompressTiling = 'offset';

/** What the page's switches mean for one run. */
export interface FactorRunPlan {
  /** Compress the run's frames, on this tiling (null: no compression). */
  compress: CompressTiling | null;
  /** The slow loop settles on the factors after the stream ends (`SlowInit.factorSettle`). */
  factorSettle: boolean;
}

export function factorRunPlan(o: {
  live: boolean;
  factors: boolean;
  compress: boolean;
  discover: boolean;
}): FactorRunPlan {
  if (o.factors && o.live && o.discover) return { compress: FACTOR_TILING, factorSettle: true };
  if (o.factors || o.compress) return { compress: 'plain', factorSettle: false };
  return { compress: null, factorSettle: false };
}

export const FACTORS_REVIEW_OFF =
  'cala: ?review is off with ?factors (the history review reads plain tiles only; a stream with ?factors compresses on offset grids).';
