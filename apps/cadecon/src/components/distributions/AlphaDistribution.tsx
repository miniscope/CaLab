import type { JSX } from 'solid-js';
import { DISTRIBUTION_COLORS } from '@calab/ui/chart';
import { HistogramCard } from './HistogramCard.tsx';
import { alphaValues } from '../../lib/iteration-store.ts';

export function AlphaDistribution(): JSX.Element {
  return <HistogramCard title="Alpha" values={alphaValues} color={DISTRIBUTION_COLORS.alpha} />;
}
