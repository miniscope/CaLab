import type { Component } from 'solid-js';
import { Show } from 'solid-js';
import { DashboardShell, DashboardPanel, VizLayout, isAuthCallback, AuthCallback } from '@calab/ui';
import { getBridgeUrl, startBridgeHeartbeat } from '@calab/io';
import { CaDeconHeader } from './components/layout/CaDeconHeader.tsx';
import { ImportOverlay } from './components/layout/ImportOverlay.tsx';
import { RasterOverview } from './components/raster/RasterOverview.tsx';
import { SubsetConfig } from './components/controls/SubsetConfig.tsx';
import { AlgorithmSettings } from './components/controls/AlgorithmSettings.tsx';
import { RunControls } from './components/controls/RunControls.tsx';
import { ProgressBar } from './components/controls/ProgressBar.tsx';
import { KernelConvergence } from './components/charts/KernelConvergence.tsx';
import { KernelDisplay } from './components/kernel/KernelDisplay.tsx';
import { TraceViewer } from './components/traces/TraceViewer.tsx';
import { AlphaDistribution } from './components/distributions/AlphaDistribution.tsx';
import { PVEDistribution } from './components/distributions/PVEDistribution.tsx';
import { EventRateDistribution } from './components/distributions/EventRateDistribution.tsx';
import { SubsetVariance } from './components/distributions/SubsetVariance.tsx';
import { SubsetDrillDown } from './components/drilldown/SubsetDrillDown.tsx';
import { user, authLoading } from './lib/auth-store.ts';
import {
  importStep,
  rawFile,
  resetImport,
  loadDemoData,
  loadFromBridge,
  bridgeUrl,
} from './lib/data-store.ts';
import { selectedSubsetIdx } from './lib/viz-store.ts';

import './styles/controls.css';
import './styles/layout.css';
import './styles/distributions.css';
import './styles/trace-viewer.css';
import './styles/kernel-display.css';
import './styles/drilldown.css';

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

  return (
    <Show
      when={importStep() === 'ready'}
      fallback={
        <ImportOverlay hasFile={!!rawFile()} onReset={resetImport} onLoadDemo={loadDemoData} />
      }
    >
      <DashboardShell header={<CaDeconHeader />}>
        <VizLayout
          mode="dashboard"
          sidebar={
            <>
              <DashboardPanel
                id="subset-config"
                variant="controls"
                label="Subset Configuration"
                collapsible
              >
                <SubsetConfig />
              </DashboardPanel>

              <DashboardPanel
                id="algorithm-settings"
                variant="controls"
                label="Algorithm Settings"
                collapsible
                defaultCollapsed
              >
                <AlgorithmSettings />
              </DashboardPanel>

              <DashboardPanel id="run-controls" variant="controls" label="Run Controls" collapsible>
                <RunControls />
                <ProgressBar />
              </DashboardPanel>
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
                <TraceViewer />
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
        </VizLayout>
      </DashboardShell>
    </Show>
  );
};

export default App;
