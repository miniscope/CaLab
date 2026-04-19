import { createEffect, onCleanup, Show, type Component } from 'solid-js';
import { DashboardShell } from '@calab/ui';
import { CaLaHeader } from './components/layout/CaLaHeader.tsx';
import { ImportOverlay } from './components/layout/ImportOverlay.tsx';
import { DashboardLayout } from './components/layout/DashboardLayout.tsx';
import { state } from './lib/data-store.ts';
import { currentArchiveWorkerForClient } from './lib/run-control.ts';
import { createArchiveClient, type ArchiveClient } from './lib/archive-client.ts';
import { applyDump, resetDashboard } from './lib/dashboard-store.ts';

const App: Component = () => {
  // Dashboard feeding: while a run is active, poll the archive worker
  // for its rolling event/metric snapshot. Lifecycle is tied to the
  // run (via runState transitions) so we tear down cleanly between
  // imports.
  createEffect(() => {
    const rs = state.runState;
    const worker = currentArchiveWorkerForClient();
    if (rs !== 'running' || worker === null) return;
    const client: ArchiveClient = createArchiveClient(worker);
    client.startPolling((dump) => {
      applyDump(dump);
    });
    onCleanup(() => {
      client.dispose();
      resetDashboard();
    });
  });

  return (
    <DashboardShell header={<CaLaHeader />}>
      <Show
        when={
          state.runState === 'starting' ||
          state.runState === 'running' ||
          state.runState === 'stopping'
        }
        fallback={<ImportOverlay />}
      >
        <DashboardLayout />
      </Show>
    </DashboardShell>
  );
};

export default App;
