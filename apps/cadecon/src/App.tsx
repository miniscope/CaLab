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
import { user, authLoading } from './lib/auth-store.ts';
import {
  importStep,
  rawFile,
  effectiveShape,
  samplingRate,
  durationSeconds,
  resetImport,
  loadDemoData,
  loadFromBridge,
  bridgeUrl,
  isDemo,
  demoPreset,
} from './lib/data-store.ts';
import { formatDuration } from '@calab/core';

import './styles/controls.css';

const App: Component = () => {
  if (isAuthCallback()) {
    return <AuthCallback user={user} loading={authLoading} />;
  }

  // Auto-load from Python bridge if ?bridge= URL param is present
  const bridgeUrlParam = getBridgeUrl();
  if (bridgeUrlParam) {
    void loadFromBridge(bridgeUrlParam).then(() => {
      if (bridgeUrl()) startBridgeHeartbeat(bridgeUrlParam);
    });
  }

  const hasFile = () => !!rawFile();

  return (
    <Show
      when={importStep() === 'ready'}
      fallback={
        <ImportOverlay
          hasFile={hasFile()}
          onReset={resetImport}
          onLoadDemo={(opts) => loadDemoData(opts)}
        />
      }
    >
      <DashboardShell header={<CaDeconHeader />}>
        <VizLayout
          mode="dashboard"
          sidebar={
            <>
              {/* Dataset info */}
              <DashboardPanel id="dataset-info" variant="data">
                <p class="panel-label">Dataset</p>
                <div class="info-summary" style="margin-bottom: 0;">
                  <Show when={isDemo()}>
                    <span>{demoPreset()?.label ?? 'Demo'}</span>
                    <span class="info-summary__sep">&middot;</span>
                  </Show>
                  <Show when={effectiveShape()}>
                    {(shape) => (
                      <>
                        <span>{shape()[0]} cells</span>
                        <span class="info-summary__sep">&middot;</span>
                        <span>{shape()[1].toLocaleString()} tp</span>
                      </>
                    )}
                  </Show>
                  <Show when={samplingRate()}>
                    <span class="info-summary__sep">&middot;</span>
                    <span>{samplingRate()} Hz</span>
                  </Show>
                  <Show when={durationSeconds()}>
                    <span class="info-summary__sep">&middot;</span>
                    <span>{formatDuration(durationSeconds())}</span>
                  </Show>
                </div>
              </DashboardPanel>

              {/* Subset config */}
              <DashboardPanel id="subset-config" variant="controls">
                <SubsetConfig />
              </DashboardPanel>

              {/* Algorithm settings */}
              <DashboardPanel id="algorithm-settings" variant="controls">
                <AlgorithmSettings />
              </DashboardPanel>

              {/* Run controls */}
              <DashboardPanel id="run-controls" variant="controls">
                <RunControls />
              </DashboardPanel>
            </>
          }
        >
          {/* Raster heatmap */}
          <DashboardPanel id="raster" variant="data">
            <p class="panel-label">Raster Overview</p>
            <RasterOverview />
          </DashboardPanel>

          {/* Placeholder for kernel convergence (Phase 2/3) */}
          <DashboardPanel id="kernel-convergence" variant="data">
            <p class="panel-label">Kernel Convergence</p>
            <p class="text-secondary" style="font-size: 0.85rem;">
              Kernel learning visualization will appear here in Phase 2.
            </p>
          </DashboardPanel>
        </VizLayout>
      </DashboardShell>
    </Show>
  );
};

export default App;
