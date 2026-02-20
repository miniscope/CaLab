// CaTune-specific community submission types.
// Extends BaseSubmission with deconvolution parameters.

import type { BaseSubmission, BaseFilterState } from '@calab/community';

/** CaTune submission row — base fields plus deconvolution parameters. */
export interface CatuneSubmission extends BaseSubmission {
  tau_rise: number;
  tau_decay: number;
  lambda: number;
  sampling_rate: number;
  ar2_g1: number;
  ar2_g2: number;
  filter_enabled?: boolean;
}

/** INSERT payload for catune_submissions. */
export type CatuneSubmissionPayload = Omit<CatuneSubmission, 'id' | 'created_at' | 'user_id'>;

/** CaTune filter state — base filters plus demo preset. */
export interface CatuneFilterState extends BaseFilterState {
  demoPreset: string | null;
}
