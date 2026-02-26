import type { JSX } from 'solid-js';
import { HistogramCard } from './HistogramCard.tsx';
import { pveValues } from '../../lib/iteration-store.ts';

export function PVEDistribution(): JSX.Element {
  return <HistogramCard title="PVE" values={pveValues} color="#2ca02c" />;
}
