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
import { user, authLoading } from './lib/auth-store.ts';
import {
  importStep,
  rawFile,
  resetImport,
  loadDemoData,
  loadFromBridge,
  bridgeUrl,
} from './lib/data-store.ts';

import './styles/controls.css';

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
              <DashboardPanel id="subset-config" variant="controls">
                <p class="panel-label">Subset Configuration</p>
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
            </>
          }
        >
          <DashboardPanel id="raster" variant="data" class="raster-panel">
            <p class="panel-label">Raster Overview</p>
            <RasterOverview />
          </DashboardPanel>

          <DashboardPanel id="kernel-convergence" variant="data">
            <p class="panel-label">Kernel Convergence</p>
            <KernelConvergence />
          </DashboardPanel>
        </VizLayout>
      </DashboardShell>
    </Show>
  );
};

export default App;
