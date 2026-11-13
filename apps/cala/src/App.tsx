import type { Component } from 'solid-js';
import { createEffect, createSignal, For, on, Show } from 'solid-js';
import { CompactHeader, DashboardShell } from '@calab/ui';
import { AuthCallback, CommunityAuthMenu, FeedbackMenu, isAuthCallback } from '@calab/community-ui';
import { authLoading, user } from '@calab/community';
import { createFrameClient } from './lib/frame-client.ts';
import { createViewerStore, FALLBACK_PLAYBACK_FPS } from './lib/viewer-store.ts';
import { createPipelineStore } from './lib/pipeline-store.ts';
import { createCellStore } from './lib/cell-store.ts';
import { createCompressClient } from './lib/compress-client.ts';
import { createCompressStore } from './lib/compress-store.ts';
import { createPass2Store, replayBlocked } from './lib/pass2-store.ts';
import { createRefineStore } from './lib/refine-store.ts';
import {
  createStageLog,
  perMinute,
  STAGE_LABEL,
  stageAvailability,
  type StageActivity,
  type StageName,
  type StageRun,
} from './lib/run-stages.ts';
import { createReviewClient } from './lib/review-client.ts';
import { createReviewStore, reviewEvery } from './lib/review-store.ts';
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
import { createRunHistory } from './lib/run-history.ts';
import { createHistoryUi, HistoryExpanded } from './components/HistoryPanel.tsx';
import { SessionSetup } from './components/SessionSetup.tsx';
import { createSessionList, toSessionInput } from './lib/session-list.ts';
import { createMultiRun } from './lib/multi-run.ts';
import { sessionBoundaries } from './lib/frame-source.ts';
import {
  directoryResultsSink,
  ensureReadwrite,
  zipResultsSink,
  type WritableDirLike,
} from './lib/session-export.ts';
import { supportsDirectoryPicker } from './lib/directory-picker.ts';
import { ProjectView } from './components/ProjectView.tsx';
import { createProjectStore } from './lib/project-store.ts';
import {
  createIndexedDbRecentStore,
  rememberProject,
  type RecentProject,
} from './lib/recent-projects.ts';
import { LIBRARY_MODE_LABEL } from './lib/session-run.ts';
import type { ExportInput } from './lib/export.ts';

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
  // The run's history over stream time: fed by the cell and pipeline stores, read by the History views.
  const runHistory = createRunHistory();
  const historyUi = createHistoryUi(runHistory);
  const cells = createCellStore(undefined, undefined, runHistory);
  // Cell discovery runs in a worker of its own, fed directly by the frame
  // worker, with its tile visits spread over the spare cores.
  // `?visits=N`: that many visit workers (0 = the slow worker visits itself).
  const visits = params.get('visits');
  // `?review` (with `?compress`): the history review, every 8 compressed windows
  // (`?review=N`: every N), in a worker of its own. One core is left for it.
  const reviewWindows = params.has('compress') ? reviewEvery(params.get('review')) : null;
  const slow = createSlowClient(
    client,
    (msg) => cells.onSlowMessage(msg),
    undefined,
    visits !== null && visits !== ''
      ? visitWorkerCount(Number(visits) + RESERVED_THREADS)
      : visitWorkerCount(navigator.hardwareConcurrency - (reviewWindows === null ? 0 : 1)),
  );
  // `?noqc`: run without online quality control (to measure its cost).
  // `?compress`: also compress the preprocessed frames into low-rank factors, window by
  // window, in a worker of its own (experimental; windows and factors are files in OPFS).
  const compress = params.has('compress') ? createCompressStore(cells) : undefined;
  // The review worker gets the factors from the compress worker; the cells it
  // finds go to the slow loop, which takes them on probation.
  const review =
    reviewWindows === null
      ? undefined
      : createReviewStore(reviewWindows, (session, candidates) =>
          slow.addReviewed(session, candidates),
        );
  const reviewClient = review ? createReviewClient((msg) => review.onMessage(msg)) : undefined;
  const compressClient = compress
    ? createCompressClient(
        client,
        (msg) => compress.onMessage(msg),
        undefined,
        review && reviewClient ? { port: reviewClient.port, every: review.every } : undefined,
      )
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
    runHistory,
    compress && review
      ? {
          reset(session) {
            compress.reset(session);
            review.reset(session);
          },
        }
      : compress,
  );
  // ---- Run stages (docs/stages.md): Discover, Refine (repeatable), Extract ----
  const stageLog = createStageLog();
  const discoverActivity = (): StageActivity => {
    const st = pipeline.status();
    return st === 'starting' || st === 'paused' ? 'running' : st;
  };
  const stageInput = () => ({
    live: store.info()?.live !== undefined,
    discover: discoverActivity(),
    refine: ((st) => (st === 'finishing' ? 'running' : st))(refine.status()) as StageActivity,
    extract: pass2.status(),
    finalLibrary: cells.status()?.final ?? false,
    cells: cells.library()?.ids.length ?? 0,
    replayBlocked: replayBlocked(pipeline),
  });
  const availability = () => stageAvailability(stageInput());
  const pass2 = createPass2Store(client, pipeline, cells, undefined, () =>
    refine.status() === 'running' || refine.status() === 'finishing' ? 'Refine is running.' : null,
  );
  const refine = createRefineStore(client, pipeline, cells, stageLog, () => availability().refine);
  /** Log a stage event on the run's timeline (at the end of what Discover read). */
  const logStage = (stage: StageName, detail: string) =>
    runHistory.log({
      frame: pipeline.processed(),
      kind: 'stage',
      to: stage,
      detail,
      replay: false,
    });
  /** Refine: a result of an earlier Extract no longer matches the footprints, so it goes. */
  function runRefine(): void {
    if (availability().refine !== null) return;
    if (pass2.result()) {
      pass2.clear();
      stageLog.invalidateExtract();
    }
    void refine.run();
  }
  // Discover: a new run starts the stage log over; it ends with the final library.
  createEffect(
    on(
      () => pipeline.status(),
      (st) => {
        if (st === 'starting') {
          stageLog.reset();
          refine.clear();
          stageLog.begin('discover');
        } else if (st === 'error') {
          stageLog.end('discover', 'error', { frames: pipeline.processed() });
        }
      },
    ),
  );
  createEffect(() => {
    const slow = cells.status();
    const run = stageLog.last('discover');
    if (pipeline.status() !== 'done' || run?.outcome !== 'running') return;
    if (slow && !slow.final && slow.run <= 1) return;
    const c = slow?.counters;
    const frames = pipeline.processed();
    const data: Partial<StageRun> = {
      frames,
      cells: cells.library()?.ids.length ?? 0,
      libraryVersion: cells.library()?.version ?? 0,
      refines: c?.refines ?? 0,
      refinesPerMin: perMinute(c?.refines ?? 0, frames, cells.fps()),
      adds: c?.adds ?? 0,
      merges: c?.merges ?? 0,
      deletes: c?.deletes ?? 0,
      splits: c?.splits ?? 0,
    };
    stageLog.end('discover', 'done', data);
    logStage('discover', `Discover done: ${data.cells} cells`);
  });
  // Extract: its store's status, into the stage log.
  createEffect(
    on(
      () => pass2.status(),
      (st) => {
        if (st === 'running') {
          stageLog.begin('extract');
          logStage('extract', 'Extract started');
        } else if (st === 'done') {
          const r = pass2.result();
          stageLog.end('extract', 'done', {
            frames: r?.frames ?? 0,
            cells: r?.cells ?? 0,
            libraryVersion: r?.version ?? 0,
          });
          logStage('extract', 'Extract done');
        } else if (st === 'error' || st === 'cancelled') {
          stageLog.end('extract', st, { frames: pass2.processed() });
          logStage('extract', `Extract ${st === 'error' ? 'stopped by an error' : 'cancelled'}`);
        }
      },
    ),
  );
  // Refine: the store logs its runs; the timeline gets the start and the end.
  createEffect(
    on(
      () => refine.status(),
      (st) => {
        if (st === 'running') logStage('refine', `${STAGE_LABEL.refine} started`);
        else if (st === 'done' || st === 'cancelled' || st === 'error') {
          const r = stageLog.last('refine');
          logStage(
            'refine',
            `${STAGE_LABEL.refine} ${r?.index ?? ''} ${st === 'done' ? 'done' : st}${
              r?.refines !== undefined ? `: ${r.refines} refines` : ''
            }`,
          );
        }
      },
    ),
  );
  // Slow-loop warnings (the reservoir filling up) go into the run's event log.
  createEffect(
    on(
      () => cells.status()?.reservoirWarning ?? null,
      (w) => {
        if (w) runHistory.log({ frame: pipeline.processed(), kind: 'warning', detail: w });
      },
    ),
  );
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
    (globalThis as { __cala?: unknown }).__cala = {
      cells,
      pipeline,
      pass2,
      refine,
      stageLog,
      runHistory,
      historyUi,
      compress,
      review,
    };
  }

  // Opening a folder starts preprocessing and motion correction right away.
  async function open(files: Parameters<typeof store.openFiles>[0], label: string) {
    pipeline.stop();
    await store.openFiles(files, label);
    if (store.info()) void pipeline.start();
  }

  // ---- Multi-session runs (docs/stages.md, "Sessions") ----
  /** The start screen: open a folder, the session list, or adding to the list. */
  const [screen, setScreen] = createSignal<'open' | 'sessions' | 'add' | 'project'>('open');
  const sessionList = createSessionList((s) =>
    client.probe ? client.probe(s) : Promise.reject(new Error('Sessions cannot be read here.')),
  );
  const version = import.meta.env.VITE_APP_VERSION || 'dev';
  const multiRun = createMultiRun({
    async openJoint(sessions) {
      pipeline.stop();
      const n = sessions.length;
      await store.openSessions(
        sessions.map((s) => toSessionInput(s.candidate)),
        `${sessions[0].candidate.name} + ${n - 1} more (${n} sessions)`,
      );
      if (store.info()) void pipeline.start();
    },
    async openOne(session, index) {
      pipeline.stop();
      const n = multiRun.plan()?.sessions.length ?? 1;
      await store.openFiles(
        session.candidate.entries,
        `Session ${index + 1} of ${n}: ${session.candidate.name}`,
      );
      if (store.info()) void pipeline.start();
    },
    stages: () => ({
      discover: discoverActivity(),
      refine: stageInput().refine,
      extract: pass2.status(),
      availability: availability(),
      runs: stageLog.runs(),
    }),
    runRefine,
    runExtract: () => void pass2.run(),
    exportInput: (): ExportInput | null => {
      const r = pass2.result();
      const i = store.info();
      if (!r || !i) return null;
      return {
        label: store.label(),
        width: i.width,
        height: i.height,
        fps: i.fps ?? 0,
        result: r,
        run: pipeline.record().snapshot(),
        flatField: pipeline.record().flatFieldApplied,
        stages: stageLog.runs(),
        qc: cells.qc(),
        firstSeen: cells.firstSeen,
        version,
      };
    },
    info: () => store.info(),
    version,
  });
  // ---- Animal projects (docs/projects.md) ----
  const recentStore = createIndexedDbRecentStore();
  const [recent, setRecent] = createSignal<RecentProject[]>([]);
  const loadRecent = () => void recentStore.list().then(setRecent);
  loadRecent();
  const project = createProjectStore({
    probe: (s) =>
      client.probe ? client.probe(s) : Promise.reject(new Error('Sessions cannot be read here.')),
    multiRun,
    recent: recentStore,
    version,
  });
  /** From the viewer back to the open project (a running plan stops). */
  function backToProject(): void {
    pipeline.stop();
    multiRun.stop();
    store.close();
    setScreen('project');
    void project.refresh();
  }

  /** Ask for `readwrite` on the results location; inside the Start click. */
  async function grantResults(): Promise<boolean> {
    if (!supportsDirectoryPicker()) return true;
    const loc = sessionList.location();
    return loc?.handle ? ensureReadwrite(loc.handle) : false;
  }
  function startSessions(settings: Parameters<typeof multiRun.start>[0]['settings']): void {
    const loc = sessionList.location();
    const handle = loc?.handle as unknown as WritableDirLike | null | undefined;
    void multiRun.start({
      sessions: sessionList.items(),
      settings,
      locationLabel: handle ? `${handle.name}/` : 'a zip download',
      openSink: () => (handle ? directoryResultsSink(handle) : Promise.resolve(zipResultsSink())),
    });
  }
  // Joint: each session boundary goes into the run's event log as Discover reaches it.
  const loggedBoundaries = new Set<number>();
  createEffect(
    on(
      () => pipeline.status(),
      (st) => {
        if (st === 'starting') loggedBoundaries.clear();
      },
    ),
  );
  createEffect(() => {
    const info = store.info();
    const spans = info?.sessions;
    if (!info || !spans || spans.length < 2) return;
    const done = pipeline.processed();
    for (const span of spans.slice(1)) {
      if (done < span.startFrame || loggedBoundaries.has(span.index)) continue;
      loggedBoundaries.add(span.index);
      runHistory.log({
        frame: span.startFrame,
        kind: 'session',
        to: span.index,
        detail: `Session ${span.index + 1}: ${span.name}`,
        replay: false,
      });
    }
  });
  if (params.has('debug')) {
    Object.assign((globalThis as { __cala?: object }).__cala ?? {}, {
      multiRun,
      sessionList,
      project,
    });
  }
  const boundaries = () => {
    const i = store.info();
    return i ? sessionBoundaries(i) : [];
  };
  // So does connecting to a live source (`?live=<url>` connects on load).
  async function openLive(url: string) {
    pipeline.stop();
    await store.openLive(url);
    if (store.info()) void pipeline.start();
  }
  const liveParam = params.get('live');

  /** A multi-session run's state, above the Run panel. */
  function SessionRunStatus() {
    return (
      <Show when={multiRun.plan()}>
        {(p) => (
          <section class="cala-session-run" data-testid="session-run" aria-label="Sessions">
            <div class="cala-session-run__head">
              <strong>
                {LIBRARY_MODE_LABEL[p().settings.mode]} run, {p().sessions.length} sessions
              </strong>{' '}
              <span class="cala-muted" data-testid="session-run-status">
                {multiRun.statusText()}
              </span>
            </div>
            <Show when={project.running() && project.planState().kind === 'running'}>
              <p class="cala-muted" data-testid="plan-progress">
                Plan: group {(project.planState() as { group: number }).group + 1} of{' '}
                {project.running()!.length}
              </p>
            </Show>
            <ol class="cala-session-run__list">
              <For each={multiRun.records()}>
                {(r) => (
                  <li
                    classList={{
                      'cala-session-run__current':
                        p().settings.mode === 'separate' && r.index === multiRun.current(),
                    }}
                    data-testid="session-run-item"
                  >
                    {r.name}{' '}
                    <span class="cala-muted">
                      {r.status}
                      {r.note ? ` (${r.note})` : ''}
                    </span>
                  </li>
                )}
              </For>
            </ol>
            <Show when={multiRun.root()}>
              {(root) => (
                <p class="cala-muted" data-testid="session-run-root">
                  Results: {p().locationLabel}
                  {root()}/
                </p>
              )}
            </Show>
          </section>
        )}
      </Show>
    );
  }

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
    const [tab, setTab] = createSignal('qc');
    const expanded = () => historyUi.expanded() && !layout().narrow;
    // Expanding swaps History into the large area and shows the FOV in the History tab.
    createEffect(
      on(historyUi.expanded, (x) => {
        if (x) setTab('history');
      }),
    );
    const fov = () => (
      <FovPanel
        store={pipeline}
        cells={cells}
        width={lp.info.width}
        height={lp.info.height}
        fps={lp.info.fps ?? FALLBACK_PLAYBACK_FPS}
      />
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
          <Show when={expanded()} fallback={fov()}>
            <HistoryExpanded ui={historyUi} />
          </Show>
        </div>
        <div class="cala-main__side">
          <RunPanel
            pipeline={pipeline}
            pass2={pass2}
            refine={refine}
            stages={stageLog}
            availability={availability()}
            onRefine={runRefine}
            cells={cells}
            live={lp.info.live !== undefined}
            label={store.label()}
            width={lp.info.width}
            height={lp.info.height}
            fps={lp.info.fps ?? 0}
            narrow={layout().narrow}
            ui={historyUi}
            compress={compress}
            review={review}
          />
          <SessionRunStatus />
          <SelectedCellPanel
            cells={cells}
            boundaries={boundaries()}
            fps={lp.info.fps ?? FALLBACK_PLAYBACK_FPS}
            folded={tab() === 'history'}
          />
          <DetailsTabs
            store={pipeline}
            cells={cells}
            viewer={store}
            info={lp.info}
            ui={historyUi}
            active={tab()}
            onActive={setTab}
            fov={() => (expanded() ? fov() : null)}
          />
        </div>
      </div>
    );
  }
  if (liveParam) void openLive(liveParam);

  return (
    <Show
      when={store.info()}
      fallback={
        <Show
          when={screen() === 'sessions' || screen() === 'project'}
          fallback={
            <OpenFolder
              onProject={(o) => {
                setScreen('project');
                void project.open(o).then(loadRecent);
              }}
              onAnimals={(handles) =>
                void (async () => {
                  for (const h of handles) await rememberProject(recentStore, h, null, new Date());
                  loadRecent();
                })()
              }
              recent={supportsDirectoryPicker() ? recent() : []}
              onForget={(r) => void recentStore.remove(r.id).then(loadRecent)}
              loading={store.loading()}
              error={store.error()}
              onOpen={(files, label) => void open(files, label)}
              onOpenLive={screen() === 'add' ? undefined : (url) => void openLive(url)}
              liveUrl={liveParam ?? undefined}
              addMode={screen() === 'add'}
              onCancel={() => setScreen('sessions')}
              onSessions={(found, handle) => {
                setScreen('sessions');
                void sessionList.add(found, handle);
              }}
            />
          }
        >
          <Show
            when={screen() === 'project'}
            fallback={
              <SessionSetup
                list={sessionList}
                onAdd={() => setScreen('add')}
                onCancel={() => {
                  sessionList.clear();
                  setScreen('open');
                }}
                grant={grantResults}
                onStart={startSessions}
              />
            }
          >
            <ProjectView
              project={project}
              onClose={() => {
                project.close();
                setScreen('open');
                loadRecent();
              }}
            />
          </Show>
        </Show>
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
                  <Show when={project.opened()}>
                    <button
                      class="btn-secondary btn-small"
                      data-testid="back-to-project"
                      title="Back to the project's session table (a running plan stops)"
                      onClick={backToProject}
                    >
                      Back to project
                    </button>
                  </Show>
                  <button
                    class="btn-secondary btn-small"
                    onClick={() => {
                      pipeline.stop();
                      multiRun.stop();
                      sessionList.clear();
                      project.close();
                      setScreen('open');
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
