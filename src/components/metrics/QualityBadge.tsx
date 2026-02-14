/**
 * Per-card quality indicator badge.
 * SNR-colored dot + solver status text:
 *   - fresh: SNR dot + "SNR X.X" or "Done (N)"
 *   - solving: SNR dot + "Iter N" with pulse
 *   - stale: SNR dot + "Stale"
 */

import type { QualityTier } from '../../lib/metrics/snr';
import type { CellSolverStatus } from '../../lib/solver-types';

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
        return props.snr != null ? `Peak SNR: ${props.snr.toFixed(1)} dB` : undefined;
    }
  };

  return (
    <span
      class={`quality-badge quality-badge--${status()}`}
      title={title()}
    >
      <span class="quality-badge__dot" style={{ background: dotColor() }} />
      <span class="quality-badge__label">{label()}</span>
    </span>
  );
}
