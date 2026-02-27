import type { Component } from 'solid-js';
import { createSignal, Show } from 'solid-js';
import {
  DashboardShell,
  DashboardPanel,
  VizLayout,
  isAuthCallback,
  AuthCallback,
  SidebarTabs,
} from '@calab/ui';
import type { SidebarTabConfig } from '@calab/ui';
import { getBridgeUrl, startBridgeHeartbeat } from '@calab/io';
import { trackEvent } from '@calab/community';
import { supabaseEnabled, user, authLoading } from './lib/community/index.ts';
import { CaDeconHeader } from './components/layout/CaDeconHeader.tsx';
import { ImportOverlay } from './components/layout/ImportOverlay.tsx';
import { RasterOverview } from './components/raster/RasterOverview.tsx';
import { SubsetConfig } from './components/controls/SubsetConfig.tsx';
import { AlgorithmSettings } from './components/controls/AlgorithmSettings.tsx';
import { RunControls } from './components/controls/RunControls.tsx';
import { ProgressBar } from './components/controls/ProgressBar.tsx';
import { KernelConvergence } from './components/charts/KernelConvergence.tsx';
import { KernelDisplay } from './components/kernel/KernelDisplay.tsx';
import { TraceInspector } from './components/traces/TraceInspector.tsx';
import { IterationScrubber } from './components/traces/IterationScrubber.tsx';
import { AlphaDistribution } from './components/distributions/AlphaDistribution.tsx';
import { PVEDistribution } from './components/distributions/PVEDistribution.tsx';
import { EventRateDistribution } from './components/distributions/EventRateDistribution.tsx';
import { SubsetVariance } from './components/distributions/SubsetVariance.tsx';
import { SubsetDrillDown } from './components/drilldown/SubsetDrillDown.tsx';
import { SubmitPanel } from './components/community/SubmitPanel.tsx';
import { CommunityBrowser } from './components/community/CommunityBrowser.tsx';
import {
  importStep,
  rawFile,
  resetImport,
  loadDemoData,
  loadFromBridge,
  bridgeUrl,
} from './lib/data-store.ts';
import { selectedSubsetIdx, setSeed } from './lib/subset-store.ts';
import { runState } from './lib/iteration-store.ts';

import './styles/controls.css';
import './styles/layout.css';
import './styles/distributions.css';
import './styles/trace-inspector.css';
import './styles/iteration-scrubber.css';
import './styles/kernel-display.css';
import './styles/drilldown.css';
import './styles/community.css';

const App: Component = () => {
  if (isAuthCallback()) {
    return <AuthCallback user={user} loading={authLoading} />;
  }

  const bridgeUrlParam = getBridgeUrl();
  if (bridgeUrlParam) {
    void loadFromBridge(bridgeUrlParam).then(() => {
      if (bridgeUrl()) startBridgeHeartbeat(bridgeUrlParam);
    });
  }

  // Right sidebar state for community panel
  const [sidebarOpen, setSidebarOpen] = createSignal(false);
  const toggleSidebar = () => setSidebarOpen((prev) => !prev);

  const communitySidebarTabs = (): SidebarTabConfig[] => {
    const list: SidebarTabConfig[] = [];
    if (supabaseEnabled) {
      list.push({
        id: 'community',
        label: 'Community',
        content: () => <CommunityBrowser />,
        onActivate: () => void trackEvent('community_browser_opened'),
      });
    }
    return list;
  };

  return (
    <Show
      when={importStep() === 'ready'}
      fallback={
        <ImportOverlay hasFile={!!rawFile()} onReset={resetImport} onLoadDemo={loadDemoData} />
      }
    >
      <DashboardShell
        sidebarOpen={sidebarOpen()}
        onToggleSidebar={toggleSidebar}
        header={<CaDeconHeader sidebarOpen={sidebarOpen()} onToggleSidebar={toggleSidebar} />}
        sidebar={
          supabaseEnabled ? (
            <SidebarTabs tabs={communitySidebarTabs()} defaultTab="community" />
          ) : undefined
        }
      >
        <VizLayout
          mode="dashboard"
          sidebar={
            <>
              <DashboardPanel id="subset-config" variant="controls">
                <p class="panel-label panel-label--with-action">
                  Subset Configuration
                  <button
                    class="panel-label__action"
                    title="Randomize layout"
                    disabled={runState() !== 'idle' && runState() !== 'complete'}
                    onClick={() => setSeed(Math.floor(Math.random() * 2 ** 31))}
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 12 12"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.5"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <path d="M1 1v3.5h3.5" />
                      <path d="M11 11V7.5H7.5" />
                      <path d="M10.2 4.5A4.5 4.5 0 0 0 2.1 2.8L1 4.5" />
                      <path d="M1.8 7.5A4.5 4.5 0 0 0 9.9 9.2L11 7.5" />
                    </svg>
                  </button>
                </p>
                <SubsetConfig />
              </DashboardPanel>

              <DashboardPanel id="algorithm-settings" variant="controls">
                <p class="panel-label">Algorithm Settings</p>
                <AlgorithmSettings />
              </DashboardPanel>

              <DashboardPanel id="run-controls" variant="controls">
                <p class="panel-label">Run Controls</p>
                <RunControls />
                <ProgressBar />
              </DashboardPanel>

              <SubmitPanel />
            </>
          }
        >
          <div class="viz-grid">
            {/* Row 1: Raster + Kernel Convergence */}
            <div class="viz-grid__row viz-grid__row--top">
              <DashboardPanel id="raster" variant="data" class="viz-grid__col--raster raster-panel">
                <p class="panel-label">Raster Overview</p>
                <RasterOverview />
              </DashboardPanel>

              <DashboardPanel
                id="kernel-convergence"
                variant="data"
                class="viz-grid__col--convergence"
              >
                <p class="panel-label">Kernel Convergence</p>
                <KernelConvergence />
              </DashboardPanel>
            </div>

            {/* Row 2: Kernel Display + Trace Viewer */}
            <div class="viz-grid__row viz-grid__row--middle">
              <DashboardPanel id="kernel-display" variant="data" class="viz-grid__col--kernel">
                <p class="panel-label">Kernel Shape</p>
                <KernelDisplay />
              </DashboardPanel>

              <DashboardPanel id="trace-viewer" variant="data" class="viz-grid__col--trace">
                <p class="panel-label">Trace Inspector</p>
                <TraceInspector />
              </DashboardPanel>
            </div>

            {/* Row 3: Distribution Cards OR Subset Drill-Down */}
            <div class="viz-grid__row viz-grid__row--bottom">
              <Show
                when={selectedSubsetIdx() != null}
                fallback={
                  <div class="viz-grid__distributions">
                    <AlphaDistribution />
                    <PVEDistribution />
                    <EventRateDistribution />
                    <SubsetVariance />
                  </div>
                }
              >
                <SubsetDrillDown />
              </Show>
            </div>
          </div>
          <IterationScrubber />
        </VizLayout>
      </DashboardShell>
    </Show>
  );
};

export default App;
