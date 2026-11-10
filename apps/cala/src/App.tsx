import type { Component } from 'solid-js';
import { createEffect, Show } from 'solid-js';
import { CompactHeader, DashboardShell } from '@calab/ui';
import { AuthCallback, CommunityAuthMenu, FeedbackMenu, isAuthCallback } from '@calab/community-ui';
import { authLoading, user } from '@calab/community';
import { createFrameClient } from './lib/frame-client.ts';
import { createViewerStore, FALLBACK_PLAYBACK_FPS } from './lib/viewer-store.ts';
import { createPipelineStore } from './lib/pipeline-store.ts';
import { createCellStore } from './lib/cell-store.ts';
import { createSlowClient } from './lib/slow-client.ts';
import { createCompressClient } from './lib/compress-client.ts';
import { createCompressStore } from './lib/compress-store.ts';
import { StatusBar } from './components/StatusBar.tsx';
import { VideoPanel } from './components/VideoPanel.tsx';
import { SelectedCellPanel } from './components/CellsPanel.tsx';
import { DetailsTabs } from './components/DetailsTabs.tsx';
import { OpenFolder } from './components/OpenFolder.tsx';
import { ConvergenceStrip } from './components/ConvergenceStrip.tsx';

const App: Component = () => {
  // Magic-link redirect: show the sign-in confirmation instead of the app.
  // `isAuthCallback()` inspects window.location at mount time; the URL
  // doesn't change within a single component lifetime, so the early
  // return is safe.
  // eslint-disable-next-line solid/components-return-once
  if (isAuthCallback()) return <AuthCallback user={user} loading={authLoading} />;

  // The worker (and the files it holds) lives as long as the app.
  // `?pipeline=0`: the old single-worker path (to compare frame rates).
  const params = new URLSearchParams(window.location.search);
  const client = createFrameClient(undefined, {
    pipelined: params.get('pipeline') !== '0',
    // `?gpu=0`: WASM motion correction (to compare with WebGPU).
    gpu: params.get('gpu') !== '0',
  });
  const store = createViewerStore(client);
  const cells = createCellStore();
  // Cell discovery runs in a worker of its own, fed directly by the frame worker.
  createSlowClient(client, (msg) => cells.onSlowMessage(msg));
  // `?noqc`: run without online quality control (to measure its cost).
  // `?compress`: also compress the preprocessed frames into low-rank factors, window by
  // window, in a worker of its own (experimental; windows and factors are files in OPFS).
  const compress = params.has('compress') ? createCompressStore(cells) : undefined;
  const compressClient = compress
    ? createCompressClient(client, (msg) => compress.onMessage(msg))
    : undefined;
  const pipeline = createPipelineStore(client, {}, undefined, cells, !params.has('noqc'), compress);
  createEffect(() => cells.setFps(store.info()?.fps ?? FALLBACK_PLAYBACK_FPS));
  // Recording read, final library out, every window compressed: solve the
  // traces of the whole recording again from the factors, with that library.
  createEffect(() => {
    const slow = cells.status();
    const done = pipeline.status() === 'done';
    if (compress?.takeBackfill(done, slow?.final ?? false, slow?.version ?? 0)) {
      compressClient?.backfill(cells.session(), slow?.version ?? 0);
    }
  });
  // `?debug`: expose the stores for measurement scripts (timing, lag, library events).
  if (params.has('debug')) {
    (globalThis as { __cala?: unknown }).__cala = { cells, pipeline, compress };
  }

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
          {/* One screen, no page scroll: status strip on top; video and
              tabbed plots on the left; the selected cell on the right. */}
          <div class="cala-main">
            <Show when={store.error()}>
              {(message) => (
                <div class="error-card" role="alert">
                  <span>{message()}</span>
                </div>
              )}
            </Show>
            <StatusBar store={pipeline} cells={cells} compress={compress} />
            <ConvergenceStrip cells={cells} />
            <div class="cala-body">
              <div class="cala-body__left">
                <VideoPanel
                  store={pipeline}
                  cells={cells}
                  width={info().width}
                  height={info().height}
                />
                <DetailsTabs store={pipeline} cells={cells} viewer={store} info={info()} />
              </div>
              <SelectedCellPanel cells={cells} fps={info().fps ?? FALLBACK_PLAYBACK_FPS} />
            </div>
          </div>
        </DashboardShell>
      )}
    </Show>
  );
};

export default App;
