import type { JSX } from 'solid-js';

interface MetricCardProps {
  label: string;
  value: number | string;
}

export function MetricCard(props: MetricCardProps): JSX.Element {
  return (
    <div class="metric-card">
      <div class="metric-card__value">{props.value}</div>
      <div class="metric-card__label">{props.label}</div>
    </div>
  );
}
