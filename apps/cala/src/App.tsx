import type { Component } from 'solid-js';
import { createEffect, createSignal, For, on, Show, untrack } from 'solid-js';
import { CompactHeader, DashboardShell } from '@calab/ui';
import { AuthCallback, CommunityAuthMenu, FeedbackMenu, isAuthCallback } from '@calab/community-ui';
import { authLoading, user } from '@calab/community';
import { createFrameClient } from './lib/frame-client.ts';
import { createViewerStore, FALLBACK_PLAYBACK_FPS } from './lib/viewer-store.ts';
import { createPipelineStore } from './lib/pipeline-store.ts';
import { createCellStore } from './lib/cell-store.ts';
import { extractQc, QC_SCOPE_DEFAULT } from './lib/extract-qc.ts';
import { loadSpanStats } from './lib/extract-qc-wasm.ts';
import { ASSUMED_FPS } from './lib/miniscope-meta.ts';
import type { QcSnapshot } from './lib/qc.ts';
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
import { FovPanel, pipelineFovSource } from './components/FovPanel.tsx';
import { SelectedCellPanel } from './components/CellsPanel.tsx';
import { BoundaryBadge } from './components/BoundaryBadge.tsx';
import { detailTabs, SideColumn } from './components/SideTabs.tsx';
import { createQcTableState } from './components/QcTable.tsx';
import { createSideTab, showPickedCell } from './lib/side-tab.ts';
import { OpenFolder } from './components/OpenFolder.tsx';
import { RunPanel, RunStatusStrip } from './components/RunPanel.tsx';
import { createFovLayout } from './lib/fov-layout.ts';
import { createRunHistory } from './lib/run-history.ts';
import { createHistoryUi, HistoryExpanded } from './components/HistoryPanel.tsx';
import { SessionSetup } from './components/SessionSetup.tsx';
import { createSessionList, toSessionInput } from './lib/session-list.ts';
import { createMultiRun } from './lib/multi-run.ts';
import { setupAnalyticsEffects } from './lib/analytics-integration.ts';
import { sessionBoundaries, sessionOfFrame } from './lib/frame-source.ts';
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
import { LIBRARY_MODE_LABEL, refinePlanText } from './lib/session-run.ts';
import { createLookbackClient } from './lib/lookback-client.ts';
import {
  CSETTLE,
  GOVERNOR,
  noiseMap,
  SETTLE,
  settleChange,
  settlePoolSize,
  unitFootprints,
} from './lib/settle.ts';
import {
  gatherRunRecord,
  primeRunRecordContext,
  RunTrace,
  settingsFromRecord,
  type RunRecordExtras,
  type RunRecordSources,
} from './lib/run-provenance.ts';
import type { LibraryView } from './workers/slow-types.ts';
import type { ExportInput } from './lib/export.ts';
import type { ProjectResult } from './lib/project-index.ts';
import { openResult, type LoadedResult } from './lib/result-file.ts';
import { ResultView, type ResultOrigin } from './components/ResultView.tsx';

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
  // Look-back (experimental): Discover refines footprints as it goes by re-reading
  // past frames in a worker of its own, and settles at the end (no Refine needed).
  // A recording on disk with one session, pipelined workers only.
  const pipelined = params.get('pipeline') !== '0';
  // The settle pool: S more look-back workers that take only the settle's chunks (worker 0
  // keeps need-driven look-back and the end settle), started when a run first goes below
  // Max. S from the core count (`settlePoolSize`); `?debug&lbpool=S` overrides it (measurement).
  const lbPool = settlePoolSize(
    typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined,
    params.has('debug') && params.has('lbpool') ? Number(params.get('lbpool')) || 0 : null,
  );
  const lookbackClient = createLookbackClient({
    slow,
    pool: lbPool,
    source: () => store.source(),
    blocked: () => {
      const i = store.info();
      if (!pipelined) return 'Look-back needs the pipelined workers (not ?pipeline=0).';
      if (!i) return 'Open a recording first.';
      if (i.live) return 'Look-back needs a recording on disk (not a live stream).';
      if ((i.sessions?.length ?? 1) > 1) return 'Look-back runs on one session (not a Joint run).';
      return null;
    },
    onError: (session, message, worker) => {
      console.warn(`cala look-back worker ${worker} (session ${session}): ${message}`);
      runHistory.log({
        frame: pipeline.processed(),
        kind: 'warning',
        detail:
          worker > 0
            ? `Look-back worker ${worker} stopped: ${message} Need-driven look-back continues.`
            : `Look-back: ${message}`,
      });
    },
  });
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
    lookbackClient,
  );
  // `?lookback`: look-back on from the first Discover start.
  if (params.has('lookback') && params.get('lookback') !== '0') pipeline.setLookback(true);
  // Background settle (settle during Discover) is on under look-back whenever the target is
  // below Max; `csettle=0` turns it off, `csettle=yield` or `csettle=yieldN` feeds each answer
  // N frames at a time (1 by default), `csrate=1|0.5` lowers the cap from 2 re-read frames
  // per live frame.
  const cs = params.get('csettle');
  if (cs === '0') pipeline.setCsettle(false);
  else if (cs !== null) {
    const y = /^yield(\d*)$/.exec(cs);
    if (y) pipeline.setCsettleYield(y[1] ? Number(y[1]) : 1);
  }
  if (params.has('csrate')) pipeline.setCsettleCeiling(Number(params.get('csrate')));
  // `?debug&needfirst` (measurement only): with one look-back worker, need-driven look-back
  // goes first and Background settle asks only when it has nothing to ask.
  if (params.has('debug') && params.has('needfirst') && params.get('needfirst') !== '0')
    pipeline.setCsettleNeedFirst(true);
  // `?debug&pacefps=30` (measurement only): read the recording at a stream's rate.
  if (params.has('debug') && params.has('pacefps'))
    pipeline.setPaceFps(Number(params.get('pacefps')));
  // `?debug`: log the time of each displayed frame change; `smooth=0` turns smooth playback off.
  if (params.has('debug')) {
    pipeline.setDisplayLog(true);
    if (params.get('smooth') === '0') pipeline.setSmoothPlayback(false);
  }
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
  // Refine's QC: the trace statistics of the replay's traces over the whole
  // recording, as after Extract (the replay runs no QC monitor).
  const refine = createRefineStore(
    client,
    pipeline,
    cells,
    stageLog,
    () => availability().refine,
    undefined,
    {
      qc: async (traces, ids) => {
        const backend = await loadSpanStats();
        const fps = store.info()?.fps ?? 0;
        const rate = fps > 0 ? fps : ASSUMED_FPS;
        const range = { start: 0, end: traces.frames };
        return extractQc(traces, ids, range, rate, QC_SCOPE_DEFAULT, cells.qc(), backend);
      },
    },
  );
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
      ...(slow?.lookback ? { lookback: true } : {}),
    };
    stageLog.end('discover', 'done', data);
    logStage('discover', `Discover done: ${data.cells} cells`);
  });
  // Extract's QC: the trace statistics recomputed on the extracted traces
  // (extract-qc.ts). Discover's last snapshot supplies the other metrics.
  let qcBase: QcSnapshot | null = null;
  async function extractQcFor(
    range: { start: number; end: number },
    fps: number,
  ): Promise<QcSnapshot | null> {
    const r = pass2.result();
    if (!r) return null;
    const backend = await loadSpanStats();
    const rate = fps > 0 ? fps : ASSUMED_FPS;
    return extractQc(r.traces, r.ids, range, rate, QC_SCOPE_DEFAULT, qcBase, backend);
  }
  // Extract: its store's status, into the stage log.
  createEffect(
    on(
      () => pass2.status(),
      (st) => {
        if (st === 'running') {
          qcBase = cells.qc();
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
          const result = r;
          if (result)
            void extractQcFor({ start: 0, end: result.frames }, store.info()?.fps ?? 0)
              .then((snap) => {
                if (snap && pass2.result() === result) cells.replaceQc(snap);
              })
              .catch((err: unknown) => console.warn('Extract QC failed:', err));
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
  let discoverEnd: {
    session: number;
    library: Pick<
      LibraryView,
      'version' | 'frame' | 'width' | 'height' | 'ids' | 'starts' | 'pixels' | 'values'
    >;
  } | null = null;
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
      /** Look-back counters of the current run (null: off), and the setting. */
      lookback: () => cells.status()?.lookback ?? null,
      lookbackOn: () => pipeline.lookbackRun(),
      /**
       * A look-back run's library at the end of Discover's frames, before the
       * end settle (null: not there yet), and how far the end settle moved it
       * against the final library's split-half noise (null until final).
       */
      discoverEnd: () => discoverEnd,
      endSettleChange: () => {
        const st = cells.status();
        const lib = cells.library();
        if (!discoverEnd || !st?.final || !lib || !st.footprintNoise) return null;
        return settleChange(
          unitFootprints(discoverEnd.library),
          unitFootprints(lib),
          noiseMap(st.footprintNoise),
        );
      },
    };
    // The library Discover ended with: the one in hand when settling starts
    // (the slow worker publishes it just before that status).
    createEffect(() => {
      if (cells.status()?.lookback?.settling !== true) return;
      const session = cells.session();
      if (discoverEnd?.session === session) return;
      const lib = untrack(() => cells.library());
      if (!lib) return;
      discoverEnd = {
        session,
        library: {
          version: lib.version,
          frame: lib.frame,
          width: lib.width,
          height: lib.height,
          ids: lib.ids.slice(),
          starts: lib.starts.slice(),
          pixels: lib.pixels.slice(),
          values: lib.values.slice(),
        },
      };
    });
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
  // ---- Run record (docs/run-record.md): how this run was made, saved with every result ----
  const runTrace = new RunTrace();
  pipeline.onPaceChange((fps, frame, source) => runTrace.noteTargetSpeed(fps, frame, source));
  pipeline.onPoolStart((workers, frame) => runTrace.notePoolStart(workers, frame));
  // A Discover start begins a new run: the target speed in force is its first entry.
  createEffect(
    on(
      () => pipeline.status() === 'starting',
      (starting) => {
        if (!starting) return;
        runTrace.reset();
        runTrace.noteTargetSpeed(pipeline.paceFps(), 0, 'run start');
      },
    ),
  );
  // The final settle's wall times (the counts come from the slow status at export).
  createEffect(() => {
    const lb = cells.status()?.lookback;
    if (lb) runTrace.noteSettle({ running: lb.settling, done: lb.settle?.done === true });
  });
  void primeRunRecordContext();
  const runRecordSources: RunRecordSources = {
    appVersion: version,
    // Build-time defines (`vite.config.ts`); undefined under tools that do not set them.
    commit: typeof __CALA_COMMIT__ === 'string' && __CALA_COMMIT__ ? __CALA_COMMIT__ : null,
    gitDirty: typeof __CALA_GIT_DIRTY__ === 'boolean' ? __CALA_GIT_DIRTY__ : null,
    engineVersion:
      typeof __CALA_ENGINE_VERSION__ === 'string' && __CALA_ENGINE_VERSION__
        ? __CALA_ENGINE_VERSION__
        : null,
    search: window.location.search,
    trace: runTrace,
    pipeline: {
      flatEnabled: pipeline.flatEnabled,
      discover: pipeline.discover,
      residual: pipeline.residual,
      lookback: pipeline.lookback,
      csettle: pipeline.csettle,
      csettleCeiling: pipeline.csettleCeiling,
      csettleYield: pipeline.csettleYield,
      csettleNeedFirst: pipeline.csettleNeedFirst,
      finalSettleLevel: pipeline.runFinalSettleLevel,
      paceFps: pipeline.paceFps,
      smoothPlayback: pipeline.smoothPlayback,
      motionBackend: pipeline.motionBackend,
      flatField: () => {
        const f = pipeline.flatField();
        return { reused: f.reused, keySource: f.key?.source ?? null };
      },
    },
    slowStatus: () => cells.status(),
    stageRuns: () => stageLog.runs(),
    info: () => store.info(),
    label: () => store.label(),
    fileSizes: () => {
      const from = store.source();
      const entries = from !== null && 'entries' in from ? from.entries : [];
      return new Map(entries.map((e) => [e.file.name, e.file.size] as const));
    },
    sessionFiles: () => {
      const from = store.source();
      return from !== null && 'sessions' in from
        ? from.sessions.map((s) => s.entries.map((e) => ({ name: e.file.name, size: e.file.size })))
        : [];
    },
    lookbackPoolSize: () => lbPool,
    visitWorkers: () => slow.visitWorkers,
    tunables: { settle: SETTLE, csettle: CSETTLE, governor: GOVERNOR },
  };
  const runRecord = (extras?: RunRecordExtras) => gatherRunRecord(runRecordSources, extras);
  const multiRun = createMultiRun({
    runRecord: (settings) => runRecord({ mode: settings.mode, refineRuns: settings.refineRuns }),
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
    sessionQc: (range, fps) => extractQcFor(range, fps),
    boundaryFlags: () => pipeline.boundaryFlags(),
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
        flatFieldMap: pipeline.flatFieldMap(),
        bitDepth: i.bitDepth,
        stages: stageLog.runs(),
        qc: cells.qc(),
        firstSeen: cells.firstSeen,
        history: {
          bins: runHistory.history().toExport(),
          eventsJson: runHistory.events().toJSON(),
        },
        version,
      };
    },
    info: () => store.info(),
    version,
  });
  // Anonymous usage analytics (docs/analytics.md): aggregate events only.
  setupAnalyticsEffects({
    stageRuns: () => stageLog.runs(),
    info: () => store.info(),
    plan: () => multiRun.plan(),
    throughput: (stage) =>
      stage === 'discover' ? pipeline.fps() : stage === 'refine' ? refine.fps() : pass2.fps(),
    stageError: (stage) =>
      stage === 'discover' ? pipeline.error() : stage === 'refine' ? refine.error() : pass2.error(),
    boundaryFlags: () => pipeline.boundaryFlags(),
    runEnded: () => multiRun.finished() || multiRun.stopped() !== null,
    sessionsWritten: () => multiRun.records().filter((r) => r.status === 'written').length,
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
  // ---- View results (docs/projects.md): a saved export, read-only ----
  const [viewing, setViewing] = createSignal<{
    result: LoadedResult;
    origin: ResultOrigin;
  } | null>(null);
  const [viewState, setViewState] = createSignal<{ busy: boolean; error: string | null }>({
    busy: false,
    error: null,
  });
  async function viewResult(r: ProjectResult): Promise<void> {
    setViewState({ busy: true, error: null });
    try {
      const file = await project.resultFile(r);
      const result = await openResult(file, r.session);
      setViewing({
        result,
        origin: {
          session: r.session,
          run: r.run,
          path: `${project.location().label}/${r.export_path}`,
          created: r.created,
        },
      });
      setViewState({ busy: false, error: null });
    } catch (err) {
      setViewState({
        busy: false,
        error: `This result could not be opened: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

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
      /** The run record of the run so far (a JSON object). */
      runRecord: () => runRecord(),
      /**
       * Re-apply the settings of a saved run record (an object, or its JSON text) before the next
       * Discover start; returns what was applied (null: not a run record).
       */
      applyRunRecord: (rec: unknown) => {
        const a = settingsFromRecord(typeof rec === 'string' ? JSON.parse(rec) : rec);
        if (!a) return null;
        if (a.flatField !== undefined) pipeline.setFlatEnabled(a.flatField);
        if (a.discover !== undefined) pipeline.setDiscover(a.discover);
        if (a.lookback !== undefined) pipeline.setLookback(a.lookback);
        if (a.csettle !== undefined) pipeline.setCsettle(a.csettle);
        if (a.csettleCeiling !== undefined) pipeline.setCsettleCeiling(a.csettleCeiling);
        if (a.csettleYield !== undefined) pipeline.setCsettleYield(a.csettleYield);
        if (a.csettleNeedFirst !== undefined) pipeline.setCsettleNeedFirst(a.csettleNeedFirst);
        if (a.finalSettleLevel !== undefined) pipeline.setFinalSettleLevel(a.finalSettleLevel);
        if (a.paceFps !== undefined) pipeline.setPaceFps(a.paceFps, 'run record');
        if (a.smoothPlayback !== undefined) pipeline.setSmoothPlayback(a.smoothPlayback);
        // The pool size is fixed at page load: say so rather than run differently in silence.
        if (a.lookbackPoolPlanned !== undefined && a.lookbackPoolPlanned !== lbPool) {
          const warning = `The record planned ${a.lookbackPoolPlanned} settle pool worker(s); this page has ${lbPool} (open it with ?debug&lbpool=${a.lookbackPoolPlanned} to match).`;
          console.warn(warning);
          return { ...a, warnings: [warning] };
        }
        return a;
      },
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

  /** "Session 3/8" in a multi-session run: the session being read (Joint: the one the frame is in). */
  const sessionLabel = (): string | null => {
    const p = multiRun.plan();
    if (!p) return null;
    const n = p.sessions.length;
    if (p.settings.mode !== 'joint') return `Session ${multiRun.current() + 1}/${n}`;
    const info = store.info();
    return `Session ${(info ? sessionOfFrame(info, pipeline.processed()) : 0) + 1}/${n}`;
  };

  /** A multi-session run's state, in the Run tab under the Run panel. */
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
              <span class="cala-muted" data-testid="session-run-refine">
                {' '}
                &middot; {refinePlanText(p().settings.refineRuns)}
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
                    <Show
                      when={
                        p().settings.mode === 'joint' &&
                        pipeline.boundaryFlags().find((f) => f.index === r.index)
                      }
                    >
                      {(f) => (
                        <>
                          {' '}
                          <BoundaryBadge flag={f()} />
                        </>
                      )}
                    </Show>
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
   * the window, on the left; on the right the run strip over one row of tabs
   * (Run, Cell, QC, History, details), one panel with the column's height.
   * Narrow windows stack the column under the image and scroll.
   */
  function Layout(lp: { info: NonNullable<ReturnType<typeof store.info>> }) {
    let main!: HTMLDivElement;
    const layout = createFovLayout(
      () => main,
      () => ({ width: lp.info.width, height: lp.info.height }),
    );
    const expanded = () => historyUi.expanded() && !layout().narrow;
    const qcState = createQcTableState();
    const fov = () => (
      <FovPanel
        source={pipelineFovSource(pipeline)}
        cells={cells}
        width={lp.info.width}
        height={lp.info.height}
        fps={lp.info.fps ?? FALLBACK_PLAYBACK_FPS}
      />
    );
    /* eslint-disable solid/reactivity -- built once per opened recording */
    const tabs = [
      {
        id: 'run',
        label: 'Run',
        testid: 'tab-run',
        keepMounted: true,
        content: () => (
          <>
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
              bitDepth={lp.info.bitDepth}
              narrow={layout().narrow}
              ui={historyUi}
              compress={compress}
              review={review}
              onStopSettling={() => slow.stopSettling(cells.session())}
              runRecord={runRecord}
              fixed
              visible={tab.active() === 'run'}
            />
            <SessionRunStatus />
          </>
        ),
      },
      {
        id: 'cell',
        label: 'Cell',
        testid: 'tab-cell',
        keepMounted: true,
        content: () => (
          <SelectedCellPanel
            cells={cells}
            boundaries={boundaries()}
            boundaryFlags={pipeline.boundaryFlags()}
            displayedFrame={pipeline.displayedFrame}
            fps={lp.info.fps ?? FALLBACK_PLAYBACK_FPS}
          />
        ),
      },
      ...detailTabs({
        store: pipeline,
        cells,
        qc: qcState,
        viewer: store,
        info: lp.info,
        ui: historyUi,
        fov: () => (expanded() ? fov() : null),
      }),
    ];
    /* eslint-enable solid/reactivity */
    const ids = tabs.map((t) => t.id);
    const tab = createSideTab('run', 'run', () => ids);
    // Expanding swaps History into the large area and shows the FOV in the History tab.
    createEffect(
      on(historyUi.expanded, (x) => {
        if (x) tab.set('history');
      }),
    );
    // Picking a cell shows it in the Cell tab (not from the FOV held in the History tab).
    showPickedCell(tab, cells.selected, () => expanded() && tab.active() === 'history');
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
          <SideColumn
            strip={
              <RunStatusStrip
                pipeline={pipeline}
                pass2={pass2}
                refine={refine}
                stages={stageLog}
                cells={cells}
                live={lp.info.live !== undefined}
                session={sessionLabel()}
              />
            }
            tabs={tabs}
            active={tab.active()}
            onActive={tab.set}
          />
        </div>
      </div>
    );
  }
  if (liveParam) void openLive(liveParam);

  /** A saved result in the viewer (read-only), with Back to project. */
  const resultScreen = (v: { result: LoadedResult; origin: ResultOrigin }) => (
    <DashboardShell
      header={
        <CompactHeader
          title="Cala"
          version={`CaLab ${import.meta.env.VITE_APP_VERSION || 'dev'}`}
          info={
            <>
              <span class="compact-header__file">{v.result.label}</span>
              <span class="compact-header__sep">&middot;</span>
              <span>
                {v.result.width} x {v.result.height}
              </span>
              <span class="compact-header__sep">&middot;</span>
              <span>{v.result.frames.toLocaleString()} frames</span>
              <span class="compact-header__sep">&middot;</span>
              <span data-testid="result-badge">saved result, read-only</span>
            </>
          }
          actions={
            <>
              <button
                class="btn-secondary btn-small"
                data-testid="back-to-project"
                title="Back to the project's session table"
                onClick={() => {
                  setViewing(null);
                  void project.refresh();
                }}
              >
                Back to project
              </button>
              <FeedbackMenu appId={__APP_ID__} />
              <CommunityAuthMenu />
            </>
          }
        />
      }
    >
      <ResultView result={v.result} origin={v.origin} />
    </DashboardShell>
  );

  return (
    <Show when={viewing()} keyed fallback={mainScreen()}>
      {(v) => resultScreen(v)}
    </Show>
  );

  function mainScreen() {
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
                    for (const h of handles)
                      await rememberProject(recentStore, h, null, new Date());
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
              <Show when={viewState().busy || viewState().error}>
                <div
                  class={viewState().error ? 'error-card' : 'cala-muted'}
                  role={viewState().error ? 'alert' : 'status'}
                  data-testid="view-status"
                >
                  {viewState().error ?? 'Opening the result...'}
                </div>
              </Show>
              <ProjectView
                project={project}
                onView={(r) => void viewResult(r)}
                onClose={() => {
                  setViewState({ busy: false, error: null });
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
  }
};

export default App;
