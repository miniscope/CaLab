import type { JSX } from 'solid-js';
import { HistogramCard } from './HistogramCard.tsx';
import { alphaValues } from '../../lib/iteration-store.ts';

export function AlphaDistribution(): JSX.Element {
  return <HistogramCard title="Alpha" values={alphaValues} color="#1f77b4" />;
}
