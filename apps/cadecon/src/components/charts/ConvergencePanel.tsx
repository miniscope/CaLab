/**
 * Tabbed panel switching between Kernel Convergence, Alpha Trends, Threshold Trends,
 * PVE Trends, and Event Rate Trends.
 * All charts remain mounted (display toggled) to preserve uPlot state across tab switches.
 */

import { createSignal, For, type JSX } from 'solid-js';
import { KernelConvergence } from './KernelConvergence.tsx';
import { AlphaTrends } from './AlphaTrends.tsx';
import { ThresholdTrends } from './ThresholdTrends.tsx';
import { PveTrends } from './PveTrends.tsx';
import { EventRateTrends } from './EventRateTrends.tsx';

type ConvergenceTab = 'kernel' | 'alpha' | 'threshold' | 'pve' | 'event-rate';

interface TabEntry {
  id: ConvergenceTab;
  label: string;
  content: () => JSX.Element;
}

const TABS: TabEntry[] = [
  { id: 'kernel', label: 'Kernel', content: () => <KernelConvergence /> },
  { id: 'alpha', label: 'Alpha', content: () => <AlphaTrends /> },
  { id: 'threshold', label: 'Threshold', content: () => <ThresholdTrends /> },
  { id: 'pve', label: 'PVE', content: () => <PveTrends /> },
  { id: 'event-rate', label: 'Event Rate', content: () => <EventRateTrends /> },
];

export function ConvergencePanel(): JSX.Element {
  const [activeTab, setActiveTab] = createSignal<ConvergenceTab>('kernel');

  return (
    <div class="convergence-panel">
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
