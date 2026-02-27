/**
 * Tabbed panel switching between Kernel Convergence, Alpha Trends, and Threshold Trends.
 * All charts remain mounted (display toggled) to preserve uPlot state across tab switches.
 */

import { createSignal, type JSX } from 'solid-js';
import { KernelConvergence } from './KernelConvergence.tsx';
import { AlphaTrends } from './AlphaTrends.tsx';
import { ThresholdTrends } from './ThresholdTrends.tsx';

type ConvergenceTab = 'kernel' | 'alpha' | 'threshold';

export function ConvergencePanel(): JSX.Element {
  const [activeTab, setActiveTab] = createSignal<ConvergenceTab>('kernel');

  return (
    <div class="convergence-panel">
      <div class="convergence-panel__tabs">
        <button
          class="convergence-panel__tab"
          classList={{ 'convergence-panel__tab--active': activeTab() === 'kernel' }}
          onClick={() => setActiveTab('kernel')}
        >
          Kernel
        </button>
        <button
          class="convergence-panel__tab"
          classList={{ 'convergence-panel__tab--active': activeTab() === 'alpha' }}
          onClick={() => setActiveTab('alpha')}
        >
          Alpha
        </button>
        <button
          class="convergence-panel__tab"
          classList={{ 'convergence-panel__tab--active': activeTab() === 'threshold' }}
          onClick={() => setActiveTab('threshold')}
        >
          Threshold
        </button>
      </div>
      <div
        class="convergence-panel__content"
        style={{ display: activeTab() === 'kernel' ? 'contents' : 'none' }}
      >
        <KernelConvergence />
      </div>
      <div
        class="convergence-panel__content"
        style={{ display: activeTab() === 'alpha' ? 'contents' : 'none' }}
      >
        <AlphaTrends />
      </div>
      <div
        class="convergence-panel__content"
        style={{ display: activeTab() === 'threshold' ? 'contents' : 'none' }}
      >
        <ThresholdTrends />
      </div>
    </div>
  );
}
