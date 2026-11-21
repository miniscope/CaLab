import type { Component } from 'solid-js';
import { Switch, Match, ErrorBoundary, Show } from 'solid-js';
import { DashboardShell, CompactHeader } from '@calab/ui';
import { isAuthCallback, AuthCallback } from '@calab/community-ui';
import { donationAuthLoading, donationUser, isDonationAuthReturn } from '@calab/community';
import { AdminGuard } from './components/AdminGuard.tsx';
import { NavBar } from './components/NavBar.tsx';
import { FilterBar } from './components/FilterBar.tsx';
import { OverviewView } from './components/OverviewView.tsx';
import { CalaView } from './components/CalaView.tsx';
import { UsersView } from './components/UsersView.tsx';
import { UsageView } from './components/UsageView.tsx';
import { GeographyView } from './components/GeographyView.tsx';
import { SubmissionsView } from './components/SubmissionsView.tsx';
import { DonationsView } from './components/DonationsView.tsx';
import { ExportPanel } from './components/ExportPanel.tsx';
import { TooltipLayer } from './components/charts/tooltip.tsx';
import { DataGate } from './components/DataGate.tsx';
import {
  activeView,
  authLoading,
  cur,
  dataset,
  refresh,
  schema,
  setFilters,
  stopLoading,
  tables,
  user,
} from './lib/admin-store.ts';
import { DEFAULT_FILTERS } from './lib/filters.ts';
import { cycleTheme, theme } from './lib/theme.ts';

const App: Component = () => {
  // Magic-link callback: show lightweight confirmation instead of full app.
  // `isAuthCallback()` inspects window.location at mount time; the URL
  // doesn't change within a single component lifetime, so the early
  // return is safe.
  // eslint-disable-next-line solid/components-return-once
  // A donation sign-in link (separate donation project) is confirmed against that project.
  if (isDonationAuthReturn()) {
    return <AuthCallback user={donationUser} loading={donationAuthLoading} />;
  }
  if (isAuthCallback()) return <AuthCallback user={user} loading={authLoading} />;

  return (
    <AdminGuard>
      <DashboardShell
        header={
          <CompactHeader
            title="CaLab Admin"
            actions={
              <button class="btn-secondary" onClick={cycleTheme} title="Theme: auto, light, dark">
                Theme: {theme()}
              </button>
            }
          />
        }
      >
        <div class="admin-layout">
          <NavBar />
          <div class="admin-content">
            {/* Donations load on their own and ignore the analytics filters. */}
            <Show when={activeView() !== 'donations'}>
              <FilterBar />
            </Show>
            <main id="main">
              <ErrorBoundary
                fallback={(err, reset) => (
                  <div class="banner banner--error" role="alert">
                    <strong>The dashboard failed to render.</strong>{' '}
                    {err instanceof Error ? err.message : String(err)}
                    <div>
                      <button
                        class="btn-secondary"
                        onClick={() => {
                          reset();
                          refresh();
                        }}
                      >
                        Retry
                      </button>
                    </div>
                  </div>
                )}
              >
                <Show
                  when={activeView() === 'donations'}
                  fallback={
                    <DataGate
                      tables={tables}
                      schemaMessages={() => schema().messages}
                      orphanEvents={() => dataset.latest?.orphanEvents ?? 0}
                      matching={() => cur().length}
                      needsSessions={activeView() !== 'submissions' && activeView() !== 'export'}
                      needsEvents={['cala', 'users', 'usage', 'export'].includes(activeView())}
                      onStop={stopLoading}
                      onSevenDays={() => setFilters((f) => ({ ...f, preset: '7d' }))}
                      onReset={() => setFilters({ ...DEFAULT_FILTERS, preset: 'all' })}
                    >
                      <Switch>
                        <Match when={activeView() === 'overview'}>
                          <OverviewView />
                        </Match>
                        <Match when={activeView() === 'cala'}>
                          <CalaView />
                        </Match>
                        <Match when={activeView() === 'users'}>
                          <UsersView />
                        </Match>
                        <Match when={activeView() === 'geography'}>
                          <GeographyView />
                        </Match>
                        <Match when={activeView() === 'usage'}>
                          <UsageView />
                        </Match>
                        <Match when={activeView() === 'submissions'}>
                          <SubmissionsView />
                        </Match>
                        <Match when={activeView() === 'export'}>
                          <ExportPanel />
                        </Match>
                      </Switch>
                    </DataGate>
                  }
                >
                  <DonationsView />
                </Show>
              </ErrorBoundary>
            </main>
          </div>
        </div>
        <TooltipLayer />
      </DashboardShell>
    </AdminGuard>
  );
};

export default App;
