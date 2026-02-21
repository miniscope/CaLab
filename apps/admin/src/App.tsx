import type { Component } from 'solid-js';
import { Show } from 'solid-js';
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
            <Show when={activeView() === 'overview'}>
              <OverviewView />
            </Show>
            <Show when={activeView() === 'usage'}>
              <UsageView />
            </Show>
            <Show when={activeView() === 'geography'}>
              <GeographyView />
            </Show>
            <Show when={activeView() === 'submissions'}>
              <SubmissionsView />
            </Show>
            <Show when={activeView() === 'export'}>
              <ExportPanel />
            </Show>
          </div>
        </div>
      </DashboardShell>
    </AdminGuard>
  );
};

export default App;
