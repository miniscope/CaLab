import type { Component } from 'solid-js';
import { Switch, Match } from 'solid-js';
import { DashboardShell, CompactHeader, isAuthCallback, AuthCallback } from '@calab/ui';
import { AdminGuard } from './components/AdminGuard.tsx';
import { NavBar } from './components/NavBar.tsx';
import { OverviewView } from './components/OverviewView.tsx';
import { UsageView } from './components/UsageView.tsx';
import { GeographyView } from './components/GeographyView.tsx';
import { SubmissionsView } from './components/SubmissionsView.tsx';
import { ExportPanel } from './components/ExportPanel.tsx';
import { DateRangeSelector } from './components/DateRangeSelector.tsx';
import { activeView, user, authLoading } from './lib/admin-store.ts';

const App: Component = () => {
  if (isAuthCallback()) {
    return <AuthCallback user={user} loading={authLoading} />;
  }

  return (
    <AdminGuard>
      <DashboardShell
        header={<CompactHeader title="CaLab Admin" actions={<DateRangeSelector />} />}
      >
        <div class="admin-layout">
          <NavBar />
          <div class="admin-content">
            <Switch>
              <Match when={activeView() === 'overview'}>
                <OverviewView />
              </Match>
              <Match when={activeView() === 'usage'}>
                <UsageView />
              </Match>
              <Match when={activeView() === 'geography'}>
                <GeographyView />
              </Match>
              <Match when={activeView() === 'submissions'}>
                <SubmissionsView />
              </Match>
              <Match when={activeView() === 'export'}>
                <ExportPanel />
              </Match>
            </Switch>
          </div>
        </div>
      </DashboardShell>
    </AdminGuard>
  );
};

export default App;
