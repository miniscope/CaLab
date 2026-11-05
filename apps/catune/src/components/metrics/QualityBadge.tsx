/**
 * Per-card SNR badge.
 * Quantile-coloured dot + solver status text:
 *   - fresh: dot + "SNR X.X" (+ "≈ noise" / "silent" tag) or "Done (N)"
 *   - solving: dot + "Iter N" with pulse
 *   - stale: dot + "Stale"
 *   - skipped: dot + "Skipped" (NaN/Inf in the trace; the card says how many)
 *
 * SNR is the shared measured SNR (same number as CaDecon). The dot colour is the
 * cell's quantile within this dataset (viridis, the same scale as the Dataset
 * histogram), not an absolute good/fair/poor grade.
 */

import { Show } from 'solid-js';
import { viridisCss } from '@calab/ui/chart';
import type { CellSolverStatus } from '../../workers/catune-types.ts';
import { describeSnr, snrTag } from '../../lib/snr-display.ts';

export interface QualityBadgeProps {
  snr?: number;
  /** Mid-rank of the SNR within the dataset, in [0, 1]. */
  rank?: number;
  /** The cell has no event above the noise-derived floor. */
  silent?: boolean;
  /** Number of cells in the dataset, for the tooltip. */
  nCells?: number;
  solverStatus?: CellSolverStatus;
  iterationCount?: number;
}

export function QualityBadge(props: QualityBadgeProps) {
  const status = () => props.solverStatus ?? 'fresh';
  const iter = () => props.iterationCount ?? 0;

  const dotColor = () =>
    props.rank != null && Number.isFinite(props.rank)
      ? viridisCss(props.rank)
      : 'var(--border-default)';

  const label = () => {
    switch (status()) {
      case 'stale':
        return 'Stale';
      case 'skipped':
        return 'Skipped';
      case 'solving':
        return `Iter ${iter()}`;
      case 'fresh':
        if (props.snr != null) return `SNR ${props.snr.toFixed(1)}`;
        return iter() > 0 ? `Done (${iter()})` : '';
      default:
        return '';
    }
  };

  const tag = () =>
    status() === 'fresh' && props.snr != null
      ? snrTag({ snr: props.snr, silent: props.silent })
      : '';

  const title = () => {
    switch (status()) {
      case 'solving':
        return `Solving — iteration ${iter()}`;
      case 'stale':
        return 'Stale — awaiting solver';
      case 'skipped':
        return 'The trace contains NaN/Inf samples, which the solver rejects, so this cell is not solved.';
      default:
        return props.snr != null
          ? describeSnr({
              snr: props.snr,
              rank: props.rank,
              silent: props.silent,
              nCells: props.nCells,
            })
          : undefined;
    }
  };

  return (
    <span class={`quality-badge quality-badge--${status()}`} title={title()}>
      <span class="quality-badge__dot" style={{ background: dotColor() }} />
      <span class="quality-badge__label">{label()}</span>
      <Show when={tag()}>
        <span class="quality-badge__tag">{tag()}</span>
      </Show>
    </span>
  );
}
