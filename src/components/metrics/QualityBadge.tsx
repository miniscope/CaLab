/**
 * Per-card quality indicator badge.
 * Small colored dot reflecting solver state:
 *   - fresh: SNR-based color (green/yellow/red)
 *   - solving: yellow pulse (actively running)
 *   - stale: red (queued, results outdated)
 */

import type { QualityTier } from '../../lib/metrics/snr';

export type SolverStatus = 'fresh' | 'solving' | 'stale';

export interface QualityBadgeProps {
  quality: QualityTier;
  snr?: number;
  solverStatus?: SolverStatus;
}

const COLORS: Record<QualityTier, string> = {
  good: 'var(--success)',
  fair: 'var(--warning)',
  poor: 'var(--error)',
};

export function QualityBadge(props: QualityBadgeProps) {
  const status = () => props.solverStatus ?? 'fresh';

  const color = () => {
    switch (status()) {
      case 'solving': return 'var(--warning)';
      case 'stale': return 'var(--error)';
      default: return COLORS[props.quality];
    }
  };

  const title = () => {
    switch (status()) {
      case 'solving': return 'Solving...';
      case 'stale': return 'Stale — awaiting solver';
      default: return props.snr != null ? `SNR: ${props.snr.toFixed(1)}` : undefined;
    }
  };

  return (
    <span
      class={`quality-badge${status() === 'solving' ? ' quality-badge--solving' : ''}`}
      title={title()}
      style={{ background: color() }}
    />
  );
}
