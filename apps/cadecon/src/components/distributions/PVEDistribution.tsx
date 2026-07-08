import type { JSX } from 'solid-js';
import { DISTRIBUTION_COLORS } from '@calab/ui/chart';
import { HistogramCard } from './HistogramCard.tsx';
import { pveValues } from '../../lib/iteration-store.ts';

export function PVEDistribution(): JSX.Element {
  return <HistogramCard title="PVE" values={pveValues} color={DISTRIBUTION_COLORS.pve} />;
}
