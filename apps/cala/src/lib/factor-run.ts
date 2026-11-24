/**
 * `?factors` (experimental; slice 2 of
 * docs/superpowers/specs/2026-11-23-cala-factors-on-settle-design.md): a
 * live stream's Final settle and Extract read the factors Discover wrote
 * during the stream. A recording with `?factors` is a `?compress` run; slice 3
 * adds recordings behind `?factors=file`.
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
  /** A recording with `?factors=file`: the settle and Extract read the factors when complete (`SlowInit.factorFile`). */
  factorFile: boolean;
}

export function factorRunPlan(o: {
  live: boolean;
  factors: boolean;
  factorsFile?: boolean;
  compress: boolean;
  discover: boolean;
  joint?: boolean;
}): FactorRunPlan {
  const none = { factorSettle: false, factorFile: false };
  if (o.factors && o.live && o.discover)
    return { compress: FACTOR_TILING, factorSettle: true, factorFile: false };
  if (o.factorsFile && !o.live && o.discover && !o.joint)
    return { compress: FACTOR_TILING, factorSettle: false, factorFile: true };
  if (o.factors || o.compress) return { compress: 'plain', ...none };
  return { compress: null, ...none };
}

export const FACTORS_FILE_JOINT =
  'cala: ?factors=file does not apply to a Joint run of several sessions; it runs as ?compress (plain tiles).';

export const FACTORS_REVIEW_OFF =
  'cala: ?review is off with ?factors (the history review reads plain tiles only; a stream with ?factors compresses on offset grids).';

/** The Results note of a `?factors` stream (the plain stream says `LIVE_NOTE`). */
export const FACTORS_LIVE_NOTE =
  "With ?factors, a live stream settles and extracts on the factors Discover wrote during the stream (there is no file to re-read). The export keeps the live traces beside Extract's.";
