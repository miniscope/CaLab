// CaDecon-specific community submission types.
// Extends BaseSubmission with automated deconvolution parameters.

import type { BaseSubmission, BaseFilterState } from '@calab/community';

/** CaDecon submission row — base fields plus kernel and run config. */
export interface CadeconSubmission extends BaseSubmission {
  // Kernel results
  tau_rise: number;
  tau_decay: number;
  beta: number | null;
  ar2_g1: number;
  ar2_g2: number;

  // Run config
  upsample_factor: number;
  sampling_rate: number;
  num_subsets: number;
  target_coverage: number;
  max_iterations: number;
  convergence_tol: number;
  weighting_enabled: boolean;
  hp_filter_enabled: boolean;
  lp_filter_enabled: boolean;

  // Aggregate results
  median_alpha: number | null;
  median_pve: number | null;
  mean_event_rate: number | null;
  num_iterations: number;
  converged: boolean;
}

/** INSERT payload for cadecon_submissions. */
export type CadeconSubmissionPayload = Omit<CadeconSubmission, 'id' | 'created_at' | 'user_id'>;

/** CaDecon filter state — base filters plus demo preset. */
export interface CadeconFilterState extends BaseFilterState {
  demoPreset: string | null;
}
