import type { Component, JSX } from 'solid-js';
import { Switch, Match, Show } from 'solid-js';
import { DashboardShell, CompactHeader } from '@calab/ui';
import { isAuthCallback, AuthCallback } from '@calab/community-ui';
import { AdminGuard } from './components/AdminGuard.tsx';
import { NavBar } from './components/NavBar.tsx';
import { FilterBar } from './components/FilterBar.tsx';
import { OverviewView } from './components/OverviewView.tsx';
import { CalaView } from './components/CalaView.tsx';
import { UsersView } from './components/UsersView.tsx';
import { UsageView } from './components/UsageView.tsx';
import { GeographyView } from './components/GeographyView.tsx';
import { SubmissionsView } from './components/SubmissionsView.tsx';
import { ExportPanel } from './components/ExportPanel.tsx';
import { TooltipLayer } from './components/charts/tooltip.tsx';
import { activeView, authLoading, cur, dataset, setFilters, user } from './lib/admin-store.ts';
import { DEFAULT_FILTERS } from './lib/filters.ts';
import { cycleTheme, theme } from './lib/theme.ts';
import { fmtNum } from './lib/stats.ts';

/** Banners and states shared by every view: error, first load, truncation, empty filter. */
function DataGate(props: { children: JSX.Element; needsSessions: boolean }): JSX.Element {
  return (
    <>
      <Show when={dataset.error}>
        <div class="banner banner--error" role="alert">
          Could not load analytics: {String((dataset.error as Error)?.message ?? dataset.error)}
        </div>
      </Show>
      <Show when={(dataset.latest?.truncated.length ?? 0) > 0}>
        <div class="banner banner--warn" role="alert">
          Row limit reached for {dataset.latest!.truncated.join(', ')}: totals are lower bounds and
          the oldest rows in the range are missing. Narrow the date range.
        </div>
      </Show>
      <Show when={(dataset.latest?.orphanEvents ?? 0) > 0}>
        <p class="note">
          {fmtNum(dataset.latest!.orphanEvents)} events belong to sessions that started before the
          loaded range and are not attributed to an app.
        </p>
      </Show>
      <Switch>
        <Match when={dataset.loading && !dataset.latest}>
          <p class="empty" role="status">
            Loading analytics...
          </p>
        </Match>
        <Match when={props.needsSessions && dataset.latest && cur().length === 0}>
          <div class="empty empty--block" role="status">
            <p>No sessions match these filters.</p>
            <button
              class="btn-secondary"
              onClick={() => setFilters({ ...DEFAULT_FILTERS, preset: 'all' })}
            >
              Reset filters and show all time
            </button>
          </div>
        </Match>
        <Match when={true}>
          <div
            class="gate"
            classList={{ 'gate--loading': dataset.loading }}
            aria-busy={dataset.loading}
          >
            {props.children}
          </div>
        </Match>
      </Switch>
    </>
  );
}

const App: Component = () => {
  // Magic-link callback: show lightweight confirmation instead of full app.
  // `isAuthCallback()` inspects window.location at mount time; the URL
  // doesn't change within a single component lifetime, so the early
  // return is safe.
  // eslint-disable-next-line solid/components-return-once
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
            <FilterBar />
            <main id="main">
              <DataGate needsSessions={activeView() !== 'submissions' && activeView() !== 'export'}>
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
            </main>
          </div>
        </div>
        <TooltipLayer />
      </DashboardShell>
    </AdminGuard>
  );
};

export default App;
