import type { Component } from 'solid-js';
import { createEffect, Show } from 'solid-js';
import { CompactHeader, DashboardShell } from '@calab/ui';
import { AuthCallback, CommunityAuthMenu, FeedbackMenu, isAuthCallback } from '@calab/community-ui';
import { authLoading, user } from '@calab/community';
import { createFrameClient } from './lib/frame-client.ts';
import { createViewerStore, FALLBACK_PLAYBACK_FPS } from './lib/viewer-store.ts';
import { createPipelineStore } from './lib/pipeline-store.ts';
import { createCellStore } from './lib/cell-store.ts';
import { createCompressClient } from './lib/compress-client.ts';
import { createCompressStore } from './lib/compress-store.ts';
import { createPass2Store } from './lib/pass2-store.ts';
import { createIndexedDbFlatFieldCache } from './lib/flat-field-cache.ts';
import {
  createSlowClient,
  PARALLEL_FORWARD_BUFFERS,
  RESERVED_THREADS,
  visitWorkerCount,
} from './lib/slow-client.ts';
import { FovPanel } from './components/FovPanel.tsx';
import { SelectedCellPanel } from './components/CellsPanel.tsx';
import { DetailsTabs } from './components/DetailsTabs.tsx';
import { OpenFolder } from './components/OpenFolder.tsx';
import { RunPanel } from './components/RunPanel.tsx';
import { createFovLayout } from './lib/fov-layout.ts';

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
  // Cell discovery runs in a worker of its own, fed directly by the frame
  // worker, with its tile visits spread over the spare cores.
  // `?visits=N`: that many visit workers (0 = the slow worker visits itself).
  const visits = params.get('visits');
  const slow = createSlowClient(
    client,
    (msg) => cells.onSlowMessage(msg),
    undefined,
    visits !== null && visits !== ''
      ? visitWorkerCount(Number(visits) + RESERVED_THREADS)
      : visitWorkerCount(navigator.hardwareConcurrency),
  );
  // `?noqc`: run without online quality control (to measure its cost).
  // `?compress`: also compress the preprocessed frames into low-rank factors, window by
  // window, in a worker of its own (experimental; windows and factors are files in OPFS).
  const compress = params.has('compress') ? createCompressStore(cells) : undefined;
  const compressClient = compress
    ? createCompressClient(client, (msg) => compress.onMessage(msg))
    : undefined;
  // `?flatfield=0`: start with the sensor flat field off (to compare frame rates).
  const pipeline = createPipelineStore(
    client,
    params.get('flatfield') === '0' ? { flatField: false } : {},
    undefined,
    cells,
    !params.has('noqc'),
    slow.visitWorkers > 0 ? PARALLEL_FORWARD_BUFFERS : undefined,
    {
      // The sensor flat field is stored per device in this browser (IndexedDB).
      cache: createIndexedDbFlatFieldCache(),
      identity: () => {
        const i = store.info();
        if (!i) return null;
        return {
          width: i.width,
          height: i.height,
          ...(i.device ? { device: i.device } : {}),
          ...(i.live ? { live: true } : {}),
          ...(i.live?.name ? { liveName: i.live.name } : {}),
          folder: store.label(),
        };
      },
    },
    compress,
  );
  const pass2 = createPass2Store(client, pipeline, cells);
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
    (globalThis as { __cala?: unknown }).__cala = { cells, pipeline, pass2, compress };
  }

  // Opening a folder starts preprocessing and motion correction right away.
  async function open(files: Parameters<typeof store.openFiles>[0], label: string) {
    pipeline.stop();
    await store.openFiles(files, label);
    if (store.info()) void pipeline.start();
  }
  // So does connecting to a live source (`?live=<url>` connects on load).
  async function openLive(url: string) {
    pipeline.stop();
    await store.openLive(url);
    if (store.info()) void pipeline.start();
  }
  const liveParam = params.get('live');

  /**
   * One screen, no page scroll: the field of view, square-ish and as tall as
   * the window, on the left; Run, Cell and the details tabs in one column on
   * the right. Narrow windows stack the column under the image and scroll.
   */
  function Layout(lp: { info: NonNullable<ReturnType<typeof store.info>> }) {
    let main!: HTMLDivElement;
    const layout = createFovLayout(
      () => main,
      () => ({ width: lp.info.width, height: lp.info.height }),
    );
    return (
      <div
        ref={main}
        class="cala-main"
        classList={{ 'cala-main--narrow': layout().narrow }}
        style={layout().narrow ? {} : { '--cala-fov-w': `${layout().fovWidth}px` }}
      >
        <Show when={store.error()}>
          {(message) => (
            <div class="error-card cala-main__error" role="alert">
              <span>{message()}</span>
            </div>
          )}
        </Show>
        <div class="cala-main__fov">
          <FovPanel
            store={pipeline}
            cells={cells}
            width={lp.info.width}
            height={lp.info.height}
            fps={lp.info.fps ?? FALLBACK_PLAYBACK_FPS}
          />
        </div>
        <div class="cala-main__side">
          <RunPanel
            pipeline={pipeline}
            pass2={pass2}
            cells={cells}
            live={lp.info.live !== undefined}
            label={store.label()}
            width={lp.info.width}
            height={lp.info.height}
            fps={lp.info.fps ?? 0}
            narrow={layout().narrow}
            compress={compress}
          />
          <SelectedCellPanel cells={cells} fps={lp.info.fps ?? FALLBACK_PLAYBACK_FPS} />
          <DetailsTabs store={pipeline} cells={cells} viewer={store} info={lp.info} />
        </div>
      </div>
    );
  }
  if (liveParam) void openLive(liveParam);

  return (
    <Show
      when={store.info()}
      fallback={
        <OpenFolder
          loading={store.loading()}
          error={store.error()}
          onOpen={(files, label) => void open(files, label)}
          onOpenLive={(url) => void openLive(url)}
          liveUrl={liveParam ?? undefined}
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
                  <span>
                    {info().live ? 'live' : `${info().frameCount.toLocaleString()} frames`}
                  </span>
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
                    {info().live ? 'Open another source' : 'Open another folder'}
                  </button>
                  <FeedbackMenu appId={__APP_ID__} />
                  <CommunityAuthMenu />
                </>
              }
            />
          }
        >
          <Layout info={info()} />
        </DashboardShell>
      )}
    </Show>
  );
};

export default App;
