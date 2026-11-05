/**
 * Tabbed analysis panel (top right of the dashboard):
 *  - Asymptote: small-multiples of the four signals that should stabilize.
 *  - Kernel: detailed kernel convergence (raw taus, per-subset scatter, GT overlay).
 *  - Results: PVE vs SNR with the dataset-level ceiling, alpha and event rate.
 * Every tab stays mounted (display toggled) to preserve chart state across switches.
 * Asymptote is the default (it is what a fresh run shows); a run that finishes
 * moves the panel to Results. The model-free dataset overview lives in the
 * right sidebar's Dataset tab (components/overview/DatasetPanel.tsx).
 */

import { createEffect, createSignal, For, on, type JSX } from 'solid-js';
import { AsymptoteTrends } from './AsymptoteTrends.tsx';
import { KernelConvergence } from './KernelConvergence.tsx';
import { ResultsPanel } from '../distributions/ResultsPanel.tsx';
import { runState } from '../../lib/iteration-store.ts';
import { nextTabForRunState, type AnalysisTab } from '../../lib/analysis-tab.ts';

export type { AnalysisTab };

interface TabEntry {
  id: AnalysisTab;
  label: string;
  content: () => JSX.Element;
}

const TABS: TabEntry[] = [
  { id: 'asymptote', label: 'Asymptote', content: () => <AsymptoteTrends /> },
  { id: 'kernel', label: 'Kernel', content: () => <KernelConvergence /> },
  { id: 'results', label: 'Results', content: () => <ResultsPanel /> },
];

const [activeTab, setActiveTab] = createSignal<AnalysisTab>('asymptote');
export { activeTab, setActiveTab };

export function AnalysisPanel(): JSX.Element {
  // A fresh run shows its convergence; a finished run shows its results.
  createEffect(
    on(runState, (state, prev) => {
      const next = nextTabForRunState(state, prev, activeTab());
      if (next !== activeTab()) setActiveTab(next);
    }),
  );

  return (
    <div class="convergence-panel" data-tutorial="kernel-convergence">
      <div class="convergence-panel__tabs" role="tablist">
        <For each={TABS}>
          {(tab) => (
            <button
              class="convergence-panel__tab"
              classList={{ 'convergence-panel__tab--active': activeTab() === tab.id }}
              role="tab"
              aria-selected={activeTab() === tab.id}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          )}
        </For>
      </div>
      <For each={TABS}>
        {(tab) => (
          <div
            class="convergence-panel__content"
            role="tabpanel"
            aria-label={tab.label}
            style={{ display: activeTab() === tab.id ? 'contents' : 'none' }}
          >
            {tab.content()}
          </div>
        )}
      </For>
    </div>
  );
}
