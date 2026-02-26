import { createMemo, type JSX } from 'solid-js';
import { HistogramCard } from './HistogramCard.tsx';
import { perTraceResults } from '../../lib/iteration-store.ts';
import { durationSeconds } from '../../lib/data-store.ts';

export function EventRateDistribution(): JSX.Element {
  const eventRates = createMemo(() => {
    const results = perTraceResults();
    const dur = durationSeconds();
    if (!dur || dur === 0) return [];
    return Object.values(results).map((r) => {
      const totalSpikes = r.sCounts.reduce((sum, v) => sum + v, 0);
      return totalSpikes / dur;
    });
  });

  return <HistogramCard title="Event Rate (Hz)" values={eventRates} color="#ff7f0e" />;
}
