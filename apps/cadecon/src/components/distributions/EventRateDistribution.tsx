import { createMemo, type JSX } from 'solid-js';
import { HistogramCard } from './HistogramCard.tsx';
import { cellResultLookup } from '../../lib/iteration-store.ts';
import { durationSeconds } from '../../lib/data-store.ts';

export function EventRateDistribution(): JSX.Element {
  const eventRates = createMemo(() => {
    const results = cellResultLookup();
    const dur = durationSeconds();
    if (!dur) return [];
    return [...results.values()].map((r) => {
      const totalSpikes = r.sCounts.reduce((sum, v) => sum + v, 0);
      return totalSpikes / dur;
    });
  });

  return <HistogramCard title="Event Rate (Hz)" values={eventRates} color="#ff7f0e" />;
}
