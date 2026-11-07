import type { Component } from 'solid-js';
import { Show } from 'solid-js';
import { CompactHeader, DashboardShell, VizLayout } from '@calab/ui';
import { AuthCallback, CommunityAuthMenu, FeedbackMenu, isAuthCallback } from '@calab/community-ui';
import { authLoading, user } from '@calab/community';
import { createFrameClient } from './lib/frame-client.ts';
import { createViewerStore } from './lib/viewer-store.ts';
import { createPipelineStore } from './lib/pipeline-store.ts';
import { PipelinePanel } from './components/PipelinePanel.tsx';
import { OpenFolder } from './components/OpenFolder.tsx';
import { FrameViewer } from './components/FrameViewer.tsx';
import { InfoPanel } from './components/InfoPanel.tsx';

const App: Component = () => {
  // Magic-link redirect: show the sign-in confirmation instead of the app.
  // `isAuthCallback()` inspects window.location at mount time; the URL
  // doesn't change within a single component lifetime, so the early
  // return is safe.
  // eslint-disable-next-line solid/components-return-once
  if (isAuthCallback()) return <AuthCallback user={user} loading={authLoading} />;

  // The worker (and the files it holds) lives as long as the app.
  const client = createFrameClient();
  const store = createViewerStore(client);
  const pipeline = createPipelineStore(client);

  // Opening a folder starts preprocessing and motion correction right away.
  async function open(files: Parameters<typeof store.openFiles>[0], label: string) {
    pipeline.stop();
    await store.openFiles(files, label);
    if (store.info()) void pipeline.start();
  }

  return (
    <Show
      when={store.info()}
      fallback={
        <OpenFolder
          loading={store.loading()}
          error={store.error()}
          onOpen={(files, label) => void open(files, label)}
        />
      }
    >
      {(info) => (
        <DashboardShell
          header={
            <CompactHeader
              title="Cala"
              version={`CaLab ${import.meta.env.VITE_APP_VERSION || 'dev'}`}
              info={
                <>
                  <span class="compact-header__file">{store.label()}</span>
                  <span class="compact-header__sep">&middot;</span>
                  <span>
                    {info().width} x {info().height}
                  </span>
                  <span class="compact-header__sep">&middot;</span>
                  <span>{info().frameCount.toLocaleString()} frames</span>
                </>
              }
              actions={
                <>
                  <button
                    class="btn-secondary btn-small"
                    onClick={() => {
                      pipeline.stop();
                      store.close();
                    }}
                  >
                    Open another folder
                  </button>
                  <FeedbackMenu appId={__APP_ID__} />
                  <CommunityAuthMenu />
                </>
              }
            />
          }
        >
          <VizLayout mode="scroll">
            <Show when={store.error()}>
              {(message) => (
                <div class="error-card" role="alert">
                  <span>{message()}</span>
                </div>
              )}
            </Show>
            <PipelinePanel store={pipeline} />
            <FrameViewer store={store} />
            <InfoPanel info={info()} />
          </VizLayout>
        </DashboardShell>
      )}
    </Show>
  );
};

export default App;
