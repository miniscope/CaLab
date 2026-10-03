import type { Component } from 'solid-js';
import { Show } from 'solid-js';
import { DashboardShell, VizLayout } from '@calab/ui';
import { ImportOverlay } from '@calab/ui/import';
import { AuthCallback, ImportFeedbackLinks, isAuthCallback } from '@calab/community-ui';
import { authLoading, user } from '@calab/community';
import { importStore as store } from './lib/data-store.ts';
import { Header } from './components/Header.tsx';
import { TraceView } from './components/TraceView.tsx';

const App: Component = () => {
  // Magic-link redirect: show the sign-in confirmation instead of the app.
  // `isAuthCallback()` inspects window.location at mount time; the URL
  // doesn't change within a single component lifetime, so the early
  // return is safe.
  // eslint-disable-next-line solid/components-return-once
  if (isAuthCallback()) return <AuthCallback user={user} loading={authLoading} />;

  return (
    <Show
      when={store.importStep() === 'ready'}
      fallback={
        <ImportOverlay
          store={store}
          title="__APP_DISPLAY_NAME__"
          subtitle="A CaLab app"
          version={`CaLab ${import.meta.env.VITE_APP_VERSION || 'dev'}`}
          layout="stacked"
          demoButtonLabel="Load Demo Data"
          samplingRatePurpose="the time axis"
          footer={<ImportFeedbackLinks appId={__APP_ID__} />}
          hasFile={!!store.rawFile()}
          onReset={store.resetImport}
          onLoadDemo={(opts) => void store.loadDemoData(opts)}
        />
      }
    >
      <DashboardShell
        header={
          <Header
            dataLabel={store.rawFile()?.name ?? 'Demo data'}
            numCells={store.numCells()}
            numTimepoints={store.numTimepoints()}
            samplingRate={store.samplingRate() ?? 0}
            onChangeData={store.resetImport}
          />
        }
      >
        <VizLayout mode="scroll">
          <TraceView store={store} />
        </VizLayout>
      </DashboardShell>
    </Show>
  );
};

export default App;
