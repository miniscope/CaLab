/**
 * Tabbed analysis panel (top right of the dashboard):
 *  - Dataset: the model-free overview of the imported data (default before a run).
 *  - Asymptote: small-multiples of the four signals that should stabilize.
 *  - Kernel: detailed kernel convergence (raw taus, per-subset scatter, GT overlay).
 *  - Results: PVE vs SNR with the dataset-level ceiling, alpha and event rate.
 * Every tab stays mounted (display toggled) to preserve chart state across switches.
 * Starting a run moves the panel from Dataset to Asymptote.
 */

import { createEffect, createSignal, For, on, type JSX } from 'solid-js';
import { AsymptoteTrends } from './AsymptoteTrends.tsx';
import { KernelConvergence } from './KernelConvergence.tsx';
import { ResultsPanel } from '../distributions/ResultsPanel.tsx';
import { DatasetPanel } from '../overview/DatasetPanel.tsx';
import { runState } from '../../lib/iteration-store.ts';

export type AnalysisTab = 'dataset' | 'asymptote' | 'kernel' | 'results';

interface TabEntry {
  id: AnalysisTab;
  label: string;
  content: () => JSX.Element;
}

const TABS: TabEntry[] = [
  { id: 'dataset', label: 'Dataset', content: () => <DatasetPanel /> },
  { id: 'asymptote', label: 'Asymptote', content: () => <AsymptoteTrends /> },
  { id: 'kernel', label: 'Kernel', content: () => <KernelConvergence /> },
  { id: 'results', label: 'Results', content: () => <ResultsPanel /> },
];

const [activeTab, setActiveTab] = createSignal<AnalysisTab>('dataset');
export { activeTab, setActiveTab };

export function AnalysisPanel(): JSX.Element {
  // Pressing Start moves the panel off the pre-run Dataset view.
  createEffect(
    on(runState, (state, prev) => {
      if (state === 'running' && prev !== 'paused' && activeTab() === 'dataset') {
        setActiveTab('asymptote');
      }
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
