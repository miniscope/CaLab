/**
 * Tabbed panel for the convergence section:
 *  - Asymptote: small-multiples of the four signals that should stabilize.
 *  - Kernel: detailed kernel convergence (raw taus, per-subset scatter, GT overlay).
 * Both charts stay mounted (display toggled) to preserve uPlot state across switches.
 */

import { createSignal, For, type JSX } from 'solid-js';
import { AsymptoteTrends } from './AsymptoteTrends.tsx';
import { KernelConvergence } from './KernelConvergence.tsx';
import { DistributionsPanel } from '../distributions/DistributionsPanel.tsx';

type ConvergenceTab = 'asymptote' | 'kernel' | 'distributions';

interface TabEntry {
  id: ConvergenceTab;
  label: string;
  content: () => JSX.Element;
}

const TABS: TabEntry[] = [
  { id: 'asymptote', label: 'Asymptote', content: () => <AsymptoteTrends /> },
  { id: 'kernel', label: 'Kernel', content: () => <KernelConvergence /> },
  { id: 'distributions', label: 'Distributions', content: () => <DistributionsPanel /> },
];

export function ConvergencePanel(): JSX.Element {
  const [activeTab, setActiveTab] = createSignal<ConvergenceTab>('asymptote');

  return (
    <div class="convergence-panel" data-tutorial="kernel-convergence">
      <div class="convergence-panel__tabs">
        <For each={TABS}>
          {(tab) => (
            <button
              class="convergence-panel__tab"
              classList={{ 'convergence-panel__tab--active': activeTab() === tab.id }}
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
            style={{ display: activeTab() === tab.id ? 'contents' : 'none' }}
          >
            {tab.content()}
          </div>
        )}
      </For>
    </div>
  );
}
