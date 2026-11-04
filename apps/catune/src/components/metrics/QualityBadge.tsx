/**
 * Per-card quality indicator badge.
 * SNR-colored dot + solver status text:
 *   - fresh: SNR dot + "SNR X.X" or "Done (N)"
 *   - solving: SNR dot + "Iter N" with pulse
 *   - stale: SNR dot + "Stale"
 */

import type { QualityTier } from '@calab/core';
import type { CellSolverStatus } from '../../workers/catune-types.ts';

export interface QualityBadgeProps {
  quality: QualityTier;
  snr?: number;
  solverStatus?: CellSolverStatus;
  iterationCount?: number;
}

const COLORS: Record<QualityTier, string> = {
  good: 'var(--success)',
  fair: 'var(--warning)',
  poor: 'var(--error)',
};

export function QualityBadge(props: QualityBadgeProps) {
  const status = () => props.solverStatus ?? 'fresh';
  const iter = () => props.iterationCount ?? 0;

  const dotColor = () => COLORS[props.quality];

  const label = () => {
    switch (status()) {
      case 'stale':
        return 'Stale';
      case 'solving':
        return `Iter ${iter()}`;
      case 'fresh':
        if (props.snr != null) return `SNR ${props.snr.toFixed(1)}`;
        return iter() > 0 ? `Done (${iter()})` : '';
      default:
        return '';
    }
  };

  const title = () => {
    switch (status()) {
      case 'solving':
        return `Solving — iteration ${iter()}`;
      case 'stale':
        return 'Stale — awaiting solver';
      default:
        return props.snr != null
          ? `Peak SNR ${props.snr.toFixed(1)}: 95th percentile above the bottom-quartile baseline, ` +
              `in units of that baseline's spread (a quick quality score; not the measured SNR ` +
              `the simulator targets)`
          : undefined;
    }
  };

  return (
    <span class={`quality-badge quality-badge--${status()}`} title={title()}>
      <span class="quality-badge__dot" style={{ background: dotColor() }} />
      <span class="quality-badge__label">{label()}</span>
    </span>
  );
}
