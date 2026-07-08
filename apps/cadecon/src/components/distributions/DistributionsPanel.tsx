/**
 * Distributions tab: final-iterate per-cell result histograms (alpha, PVE, event
 * rate). These are the appropriate form for per-cell results — a distribution
 * across cells at the current iterate — rather than a per-iteration trend.
 */

import { type JSX } from 'solid-js';
import { AlphaDistribution } from './AlphaDistribution.tsx';
import { PVEDistribution } from './PVEDistribution.tsx';
import { EventRateDistribution } from './EventRateDistribution.tsx';

export function DistributionsPanel(): JSX.Element {
  return (
    <div class="asymptote-grid">
      <AlphaDistribution />
      <PVEDistribution />
      <EventRateDistribution />
    </div>
  );
}
