// App.tsx - Import flow orchestration using data store signals
// Conditionally renders components based on importStep

import type { Component } from 'solid-js';
import { Show, createEffect, createSignal, on } from 'solid-js';

import { AuthCallback } from './components/auth/AuthCallback.tsx';
import { ParameterPanel } from './components/controls/ParameterPanel.tsx';
import { CellSelector } from './components/controls/CellSelector.tsx';
import { SubmitPanel } from './components/community/SubmitPanel.tsx';
import { CommunityBrowser } from './components/community/CommunityBrowser.tsx';
import { TutorialPanel } from './components/tutorial/TutorialPanel.tsx';
import { DashboardPanel, VizLayout, DashboardShell } from '@calab/ui';
import { CaTuneHeader } from './components/layout/CompactHeader.tsx';
import { ImportOverlay } from './components/layout/ImportOverlay.tsx';
import { KernelDisplay } from './components/traces/KernelDisplay.tsx';
import { CardGrid } from './components/cards/CardGrid.tsx';
import { SidebarTabs } from './components/layout/SidebarTabs.tsx';
import { MetricsPanel } from './components/metrics/MetricsPanel.tsx';
import { SpectrumPanel } from './components/spectrum/SpectrumPanel.tsx';
import { initSpectrumStore } from './lib/spectrum/spectrum-store.ts';

import {
  importStep,
  rawFile,
  parsedData,
  effectiveShape,
  resetImport,
  loadDemoData,
} from './lib/data-store.ts';
import {
  setSelectedCell,
  pinnedParams,
  pinCurrentSnapshot,
  unpinSnapshot,
} from './lib/viz-store.ts';
import { computeAndCacheRanking, updateCellSelection } from './lib/multi-cell-store.ts';
import { initCellSolveManager } from './lib/cell-solve-manager.ts';
import { supabaseEnabled } from './lib/community/index.ts';
import { isTutorialActive } from './lib/tutorial/tutorial-store.ts';
import { startTutorial } from './lib/tutorial/tutorial-engine.ts';
import { getTutorialById } from './lib/tutorial/content/index.ts';

import './styles/multi-trace.css';
import './styles/community.css';
import './styles/cards.css';

const BANNER_DISMISSED_KEY = 'catune-tutorial-dismissed';

function loadBannerDismissedState(): boolean {
  try {
    return localStorage.getItem(BANNER_DISMISSED_KEY) === 'true';
  } catch {
    return false;
  }
}

/** Supabase magic-link redirects append auth tokens to the URL hash. */
function isAuthCallback(): boolean {
  const hash = window.location.hash;
  return hash.includes('access_token=') || hash.includes('token_hash=');
}

const App: Component = () => {
  // Magic-link callback: show lightweight confirmation instead of full app
  if (isAuthCallback()) {
    return <AuthCallback />;
  }

  const hasFile = () => !!rawFile();

  // Sidebar state — owned by the app, passed to DashboardShell & CaTuneHeader
  const [sidebarOpen, setSidebarOpen] = createSignal(false);
  const toggleSidebar = () => setSidebarOpen((prev) => !prev);

  // Tutorial panel state
  const [tutorialOpen, setTutorialOpen] = createSignal(false);

  // First-time banner: show if not dismissed and data is loaded
  const [bannerDismissed, setBannerDismissed] = createSignal(loadBannerDismissedState());
  const showBanner = () => importStep() === 'ready' && !bannerDismissed();

  const dismissBanner = () => {
    setBannerDismissed(true);
    try {
      localStorage.setItem(BANNER_DISMISSED_KEY, 'true');
    } catch {
      /* ignore */
    }
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

  // Initialize cell solve manager and cell selection when data is ready
  createEffect(
    on(importStep, (currentStep) => {
      if (currentStep === 'ready') {
        const data = parsedData();
        const shape = effectiveShape();
        if (data && shape) {
          computeAndCacheRanking();
          updateCellSelection();
          initCellSolveManager();
          initSpectrumStore();
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
        when={importStep() === 'ready'}
        fallback={
          <ImportOverlay
            hasFile={hasFile()}
            onReset={resetImport}
            onLoadDemo={(opts) => loadDemoData(opts)}
          />
        }
      >
        <DashboardShell
          sidebarOpen={sidebarOpen()}
          onToggleSidebar={toggleSidebar}
          header={
            <CaTuneHeader
              tutorialOpen={tutorialOpen}
              onTutorialToggle={() => setTutorialOpen((prev) => !prev)}
              sidebarOpen={sidebarOpen()}
              onToggleSidebar={toggleSidebar}
            />
          }
          sidebar={
            <SidebarTabs
              communityContent={supabaseEnabled ? <CommunityBrowser /> : undefined}
              spectrumContent={<SpectrumPanel />}
              metricsContent={<MetricsPanel />}
            />
          }
        >
          <VizLayout mode="dashboard">
            {/* Left strip: Parameters + Kernel */}
            <div class="param-strip">
              <DashboardPanel id="parameters" variant="controls">
                <ParameterPanel />
              </DashboardPanel>

              <DashboardPanel id="kernel" variant="data">
                <KernelDisplay />
              </DashboardPanel>

              <DashboardPanel id="toolbar" variant="controls">
                <div class="param-strip__toolbar">
                  <button
                    class={`btn-secondary btn-small ${pinnedParams() ? 'btn-active' : ''}`}
                    onClick={() => (pinnedParams() ? unpinSnapshot() : pinCurrentSnapshot())}
                    data-tutorial="pin-snapshot"
                  >
                    {pinnedParams() ? 'Unpin' : 'Pin'}
                  </button>
                  <Show when={pinnedParams()}>
                    {(params) => (
                      <span class="param-strip__pin-info">
                        {(params().tauRise * 1000).toFixed(0)}ms /{' '}
                        {(params().tauDecay * 1000).toFixed(0)}ms
                      </span>
                    )}
                  </Show>
                  <SubmitPanel />
                </div>
              </DashboardPanel>
            </div>

            {/* Center: Cell selector bar + Card Grid */}
            <div class="main-content-area">
              <CellSelector />
              <CardGrid onCellClick={(idx) => setSelectedCell(idx)} />
            </div>
          </VizLayout>
        </DashboardShell>
      </Show>
    </>
  );
};

export default App;
