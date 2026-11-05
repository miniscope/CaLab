// Tab logic for the analysis panel (components/charts/AnalysisPanel.tsx),
// kept out of the component so it can be unit-tested without the charts.

import type { RunState } from './iteration-store.ts';

export type AnalysisTab = 'asymptote' | 'kernel' | 'results';

/**
 * Automatic tab moves on run-state changes. Only the two "auto" tabs move each
 * other, so a user who chose Kernel stays there:
 *  - a fresh start (not a resume) brings Results back to Asymptote;
 *  - a run that ends (finished or stopped) moves Asymptote to Results.
 */
export function nextTabForRunState(
  state: RunState,
  prev: RunState | undefined,
  current: AnalysisTab,
): AnalysisTab {
  if (state === 'running' && prev !== 'paused' && current === 'results') return 'asymptote';
  if (state === 'complete' && prev !== 'complete' && current === 'asymptote') return 'results';
  return current;
}
