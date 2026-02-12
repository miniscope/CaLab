// App.tsx - Import flow orchestration using data store signals
// Conditionally renders components based on importStep

import type { Component } from 'solid-js';
import { Show, createEffect, createSignal, on } from 'solid-js';

import { ParameterPanel } from './components/controls/ParameterPanel.tsx';
import { CellSelector } from './components/controls/CellSelector.tsx';
import { SubmitPanel } from './components/community/SubmitPanel.tsx';
import { CommunityBrowser } from './components/community/CommunityBrowser.tsx';
import { TutorialPanel } from './components/tutorial/TutorialPanel.tsx';
import { DashboardPanel } from './components/layout/DashboardPanel.tsx';
import { VizLayout } from './components/layout/VizLayout.tsx';
import { DashboardShell } from './components/layout/DashboardShell.tsx';
import { CompactHeader } from './components/layout/CompactHeader.tsx';
import { ImportOverlay } from './components/layout/ImportOverlay.tsx';
import { KernelDisplay } from './components/traces/KernelDisplay.tsx';
import { CardGrid } from './components/cards/CardGrid.tsx';
import { SidebarTabs } from './components/layout/SidebarTabs.tsx';
import { MetricsPanel } from './components/metrics/MetricsPanel.tsx';

import {
  importStep,
  rawFile,
  parsedData,
  effectiveShape,
  swapped,
  samplingRate,
  resetImport,
  loadDemoData,
} from './lib/data-store.ts';
import {
  loadCellTraces,
  tauRise,
  tauDecay,
  lambda,
  pinnedParams,
  pinCurrentSnapshot,
  unpinSnapshot,
} from './lib/viz-store.ts';
import {
  computeAndCacheRanking,
  updateCellSelection,
  selectedCells,
} from './lib/multi-cell-store.ts';
import { solveSelectedCells } from './lib/multi-cell-solver.ts';
import { startTuningLoop } from './lib/tuning-orchestrator.ts';
import { supabaseEnabled } from './lib/supabase.ts';
import { isTutorialActive } from './lib/tutorial/tutorial-store.ts';
import { startTutorial } from './lib/tutorial/tutorial-engine.ts';
import { getTutorialById } from './lib/tutorial/content/index.ts';

import './styles/multi-trace.css';
import './styles/community.css';
import './styles/cards.css';

const BANNER_DISMISSED_KEY = 'catune-tutorial-dismissed';

function loadBannerDismissedState(): boolean {
  try { return localStorage.getItem(BANNER_DISMISSED_KEY) === 'true'; } catch { return false; }
}

const App: Component = () => {
  const step = () => importStep();
  const hasFile = () => !!rawFile();

  // Tutorial panel state
  const [tutorialOpen, setTutorialOpen] = createSignal(false);

  // First-time banner: show if not dismissed and data is loaded
  const [bannerDismissed, setBannerDismissed] = createSignal(loadBannerDismissedState());
  const showBanner = () => importStep() === 'ready' && !bannerDismissed();

  const dismissBanner = () => {
    setBannerDismissed(true);
    try { localStorage.setItem(BANNER_DISMISSED_KEY, 'true'); } catch { /* ignore */ }
  };

  const launchBasicsTutorial = () => {
    const basics = getTutorialById('basics');
    if (basics) {
      startTutorial(basics);
      dismissBanner();
      setTutorialOpen(false);
    }
  };

  // Close tutorial panel when a tutorial becomes active
  createEffect(
    on(isTutorialActive, (active) => {
      if (active) setTutorialOpen(false);
    }),
  );

  // Trigger batch re-solve for selected cells with current parameters
  const triggerBatchSolve = () => {
    const data = parsedData();
    const shape = effectiveShape();
    const cells = selectedCells();
    if (!data || !shape || cells.length === 0) return;
    solveSelectedCells(
      cells,
      { tauRise: tauRise(), tauDecay: tauDecay(), lambda: lambda(), fs: samplingRate() ?? 30 },
      data,
      shape,
      swapped(),
    );
  };

  // Handle card click to switch primary cell
  const handleCellClick = (cellIndex: number) => {
    const data = parsedData();
    const shape = effectiveShape();
    if (data && shape) {
      loadCellTraces(cellIndex, data, shape, swapped());
    }
  };

  // Load first cell's traces and start tuning loop when import reaches 'ready'
  createEffect(
    on(importStep, (currentStep) => {
      if (currentStep === 'ready') {
        const data = parsedData();
        const shape = effectiveShape();
        if (data && shape) {
          loadCellTraces(0, data, shape, swapped());
          startTuningLoop();
          computeAndCacheRanking();
          updateCellSelection();
          setTimeout(triggerBatchSolve, 100);
        }
      }
    }),
  );

  return (
    <>
    {/* Tutorial panel -- shown when toggled */}
    <Show when={tutorialOpen()}>
      <TutorialPanel onClose={() => setTutorialOpen(false)} />
    </Show>

    {/* First-time banner */}
    <Show when={showBanner()}>
      <div class="tutorial-banner">
        <span class="tutorial-banner__text">
          New to CaTune? Start with the basics tutorial to learn the parameter tuning workflow.
        </span>
        <div class="tutorial-banner__actions">
          <button class="btn-secondary btn-small" onClick={launchBasicsTutorial}>
            Start Tutorial
          </button>
          <button class="tutorial-banner__dismiss" onClick={dismissBanner} aria-label="Dismiss">
            &times;
          </button>
        </div>
      </div>
    </Show>

    {/* Import flow (full-page) OR Dashboard */}
    <Show
      when={step() === 'ready'}
      fallback={
        <ImportOverlay
          hasFile={hasFile()}
          onReset={resetImport}
          onLoadDemo={loadDemoData}
        />
      }
    >
      <DashboardShell
        header={
          <CompactHeader
            tutorialOpen={tutorialOpen}
            onTutorialToggle={() => setTutorialOpen(prev => !prev)}
          />
        }
        sidebar={
          supabaseEnabled
            ? <SidebarTabs
                communityContent={<CommunityBrowser />}
                metricsContent={<MetricsPanel />}
              />
            : <MetricsPanel />
        }
      >
        <VizLayout mode="dashboard">
          {/* Left strip: Parameters + Kernel */}
          <div class="param-strip">
            <DashboardPanel id="parameters" variant="controls">
              <ParameterPanel onBatchSolve={triggerBatchSolve} />
            </DashboardPanel>

            <DashboardPanel id="kernel" variant="data">
              <KernelDisplay />
            </DashboardPanel>

            <DashboardPanel id="toolbar" variant="controls">
              <div class="param-strip__toolbar">
                <button
                  class={`btn-secondary btn-small ${pinnedParams() ? 'btn-active' : ''}`}
                  onClick={() => pinnedParams() ? unpinSnapshot() : pinCurrentSnapshot()}
                  data-tutorial="pin-snapshot"
                >
                  {pinnedParams() ? 'Unpin' : 'Pin'}
                </button>
                <Show when={pinnedParams()}>
                  {(params) => (
                    <span class="param-strip__pin-info">
                      {(params().tauRise * 1000).toFixed(0)}ms / {(params().tauDecay * 1000).toFixed(0)}ms
                    </span>
                  )}
                </Show>
                <SubmitPanel />
              </div>
            </DashboardPanel>
          </div>

          {/* Center: Cell selector bar + Card Grid */}
          <div class="main-content-area">
            <CellSelector onSelectionChange={triggerBatchSolve} />
            <CardGrid onCellClick={handleCellClick} />
          </div>
        </VizLayout>
      </DashboardShell>
    </Show>
    </>
  );
};

export default App;
