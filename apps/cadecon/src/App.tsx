import type { Component, JSX } from 'solid-js';
import { createEffect, createSignal, Show } from 'solid-js';
import { DashboardShell, DashboardPanel, VizLayout, createDashboardSidebar } from '@calab/ui';
import {
  isAuthCallback,
  AuthCallback,
  SidebarTabs,
  TrackedTutorialPanel,
} from '@calab/community-ui';
import type { SidebarTabConfig } from '@calab/community-ui';
import { getBridgeUrl, startBridgeHeartbeat } from '@calab/io';
import { initBridgeConfig, setupBridgeEffects } from './lib/bridge-effects.ts';
import { trackEvent } from '@calab/community';
import { supabaseEnabled, user, authLoading } from './lib/community/index.ts';
import { CaDeconHeader } from './components/layout/CaDeconHeader.tsx';
import { tutorials } from './lib/tutorial/content/index.ts';
import { ResizableGrid } from './components/layout/ResizableGrid.tsx';
import { ImportOverlay } from './components/layout/ImportOverlay.tsx';
import { RasterOverview } from './components/raster/RasterOverview.tsx';
import { SubsetConfig } from './components/controls/SubsetConfig.tsx';
import { AlgorithmSettings } from './components/controls/AlgorithmSettings.tsx';
import { RunControls } from './components/controls/RunControls.tsx';
import { ProgressBar } from './components/controls/ProgressBar.tsx';
import { AnalysisPanel } from './components/charts/AnalysisPanel.tsx';
import { KernelDisplay } from './components/kernel/KernelDisplay.tsx';
import { TraceInspector } from './components/traces/TraceInspector.tsx';
import { IterationScrubber } from './components/traces/IterationScrubber.tsx';
import { SubmitPanel } from './components/community/SubmitPanel.tsx';
import { CommunityBrowser } from './components/community/CommunityBrowser.tsx';
import { DatasetPanel } from './components/overview/DatasetPanel.tsx';
import {
  importStep,
  rawFile,
  resetImport,
  loadDemoData,
  loadFromBridge,
  bridgeUrl,
  parsedData,
} from './lib/data-store.ts';
import { setSeed } from './lib/subset-store.ts';
import { isRunLocked } from './lib/iteration-store.ts';
import { setupOverviewEffects, overview } from './lib/overview-store.ts';

import '@calab/ui/styles/app-controls.css';
import './styles/controls.css';
import './styles/layout.css';
import './styles/trace-inspector.css';
import './styles/iteration-scrubber.css';
import './styles/kernel-display.css';
import './styles/distributions.css';
import './styles/community.css';

function DiceIcon(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
      <rect
        x="1"
        y="1"
        width="14"
        height="14"
        rx="2"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
      />
      <circle cx="4.5" cy="4.5" r="1.2" />
      <circle cx="8" cy="8" r="1.2" />
      <circle cx="11.5" cy="11.5" r="1.2" />
    </svg>
  );
}

const App: Component = () => {
  // Magic-link callback: show lightweight confirmation instead of full app.
  // `isAuthCallback()` inspects window.location at mount time; the URL
  // doesn't change within a single component lifetime, so the early
  // return is safe.
  // eslint-disable-next-line solid/components-return-once
  if (isAuthCallback()) return <AuthCallback user={user} loading={authLoading} />;

  const bridgeUrlParam = getBridgeUrl();
  if (bridgeUrlParam) {
    void loadFromBridge(bridgeUrlParam).then(() => {
      if (bridgeUrl()) {
        startBridgeHeartbeat(bridgeUrlParam);
        void initBridgeConfig(bridgeUrlParam);
      }
    });
  }
  setupBridgeEffects();
  setupOverviewEffects();

  // Right sidebar: Dataset overview (always) + Community (when configured).
  const sidebar = createDashboardSidebar('dataset');
  const sidebarOpen = sidebar.open;
  const toggleSidebar = sidebar.toggle;

  // Surface the dataset overview once per loaded dataset, unless the user has
  // closed the sidebar this session.
  let revealedFor: unknown = null;
  createEffect(() => {
    const data = parsedData();
    if (!overview() || !data || data === revealedFor) return;
    revealedFor = data;
    sidebar.reveal('dataset');
  });

  // Tutorial selection panel open state (owned here, mirrors CaTune).
  const [tutorialOpen, setTutorialOpen] = createSignal(false);
  const toggleTutorial = () => setTutorialOpen((prev) => !prev);

  const sidebarTabs = (): SidebarTabConfig[] => {
    const list: SidebarTabConfig[] = [
      { id: 'dataset', label: 'Dataset', content: () => <DatasetPanel /> },
    ];
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
      <>
        {/* Tutorial panel — shown when toggled. Mounted at top so it reads as a
            banner strip above the dashboard, matching CaTune. */}
        <Show when={tutorialOpen()}>
          <TrackedTutorialPanel
            tutorials={tutorials}
            isDataReady={() => importStep() === 'ready'}
            onClose={() => setTutorialOpen(false)}
          />
        </Show>

        <DashboardShell
          sidebarOpen={sidebarOpen()}
          onToggleSidebar={toggleSidebar}
          header={
            <CaDeconHeader
              sidebarOpen={sidebarOpen()}
              onToggleSidebar={toggleSidebar}
              tutorialOpen={tutorialOpen()}
              onTutorialToggle={toggleTutorial}
            />
          }
          sidebarWidth="clamp(400px, 30vw, 560px)"
          sidebarResizable
          sidebar={
            <SidebarTabs
              tabs={sidebarTabs()}
              activeTab={sidebar.tab()}
              onTabChange={sidebar.setTab}
            />
          }
        >
          <VizLayout
            mode="dashboard"
            sidebar={
              <>
                <DashboardPanel id="subset-config" variant="controls" data-tutorial="subset-config">
                  <p class="panel-label panel-label--with-action">
                    Subset Configuration
                    <button
                      class="panel-label__action"
                      title="Randomize subset tiling"
                      disabled={isRunLocked()}
                      onClick={() => setSeed(Math.floor(Math.random() * 2 ** 31))}
                    >
                      <DiceIcon />
                    </button>
                  </p>
                  <SubsetConfig />
                </DashboardPanel>

                <DashboardPanel
                  id="algorithm-settings"
                  variant="controls"
                  data-tutorial="algorithm-settings"
                >
                  <p class="panel-label">Algorithm Settings</p>
                  <AlgorithmSettings />
                </DashboardPanel>

                <DashboardPanel id="run-controls" variant="controls" data-tutorial="run-controls">
                  <p class="panel-label">Run Controls</p>
                  <RunControls />
                  <ProgressBar />
                </DashboardPanel>

                <DashboardPanel id="submit" variant="controls">
                  <SubmitPanel />
                </DashboardPanel>
              </>
            }
          >
            <ResizableGrid>
              <DashboardPanel
                id="raster"
                variant="data"
                class="viz-grid__col--raster raster-panel"
                data-tutorial="raster"
              >
                <RasterOverview />
              </DashboardPanel>

              <DashboardPanel
                id="kernel-convergence"
                variant="data"
                class="viz-grid__col--convergence"
              >
                <AnalysisPanel />
              </DashboardPanel>

              <DashboardPanel
                id="kernel-display"
                variant="data"
                class="viz-grid__col--kernel"
                data-tutorial="kernel-display"
              >
                <p class="panel-label">Kernel Shape</p>
                <KernelDisplay />
              </DashboardPanel>

              <DashboardPanel
                id="trace-viewer"
                variant="data"
                class="viz-grid__col--trace"
                data-tutorial="trace-viewer"
              >
                <p class="panel-label">Trace Inspector</p>
                <TraceInspector />
              </DashboardPanel>
            </ResizableGrid>
            <IterationScrubber />
          </VizLayout>
        </DashboardShell>
      </>
    </Show>
  );
};

export default App;
