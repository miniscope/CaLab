import type { Component } from 'solid-js';
import { clearResultExported, leaveWarning, resultExported } from './lib/export-state.ts';
import { createEffect, createSignal, For, on, onCleanup, Show, untrack } from 'solid-js';
import { Badge, CompactHeader, DashboardShell, MeterRow, ThemeToggle } from '@calab/ui';
import { AuthCallback, CommunityAuthMenu, FeedbackMenu, isAuthCallback } from '@calab/community-ui';
import {
  authLoading,
  donationAuthError,
  donationAuthLoading,
  donationEnabled,
  donationUser,
  initDonationAuth,
  isDonationAuthReturn,
  user,
} from '@calab/community';
import { createFrameClient } from './lib/frame-client.ts';
import { createViewerStore, FALLBACK_PLAYBACK_FPS } from './lib/viewer-store.ts';
import { createPipelineStore } from './lib/pipeline-store.ts';
import { createCellStore } from './lib/cell-store.ts';
import { extractQc, QC_SCOPE_DEFAULT } from './lib/extract-qc.ts';
import { loadSpanStats } from './lib/extract-qc-wasm.ts';
import type { QcSnapshot } from './lib/qc.ts';
import { createCompressClient } from './lib/compress-client.ts';
import { helpersFor } from './lib/compress-pool.ts';
import {
  createCompressStore,
  fileFactorsBlocked,
  FactorWatchdog,
  factorsBlocked,
} from './lib/compress-store.ts';
import { createFactorExtract } from './lib/factor-extract.ts';
import { FACTOR_STALL_TEXT, FactorSettle, FileSettleChoice } from './lib/factor-settle.ts';
import { STOPPED_TEXT } from './lib/compress-runner.ts';
import { parsePageFlags } from './lib/page-flags.ts';
import { createPass2Store, replayBlocked } from './lib/pass2-store.ts';
import {
  createStageLog,
  perMinute,
  stageAvailability,
  type StageActivity,
  type StageName,
  type StageRun,
} from './lib/run-stages.ts';
import { createReviewClient } from './lib/review-client.ts';
import { createReviewStore, reviewEvery } from './lib/review-store.ts';
import { createIndexedDbFlatFieldCache } from './lib/flat-field-cache.ts';
import { createSlowClient, PARALLEL_FORWARD_BUFFERS } from './lib/slow-client.ts';
import { threadBudget } from './lib/thread-budget.ts';
import { FovPanel, pipelineFovSource } from './components/FovPanel.tsx';
import { SelectedCellPanel } from './components/CellsPanel.tsx';
import { BoundaryBadge } from './components/BoundaryBadge.tsx';
import { detailTabs, SideColumn } from './components/SideTabs.tsx';
import { createQcTableState } from './components/QcTable.tsx';
import { createSideTab, showPickedCell } from './lib/side-tab.ts';
import { OpenFolder } from './components/OpenFolder.tsx';
import { RunPanel } from './components/RunPanel.tsx';
import { ExportMenu } from './components/ExportMenu.tsx';
import { createLiveResult } from './lib/live-export.ts';
import type { LiveResultState } from './lib/session-run.ts';
import { RunRail, type RailSession } from './components/RunRail.tsx';
import { createFovLayout } from './lib/fov-layout.ts';
import { createRunHistory } from './lib/run-history.ts';
import { createHistoryUi, HistoryExpanded } from './components/HistoryPanel.tsx';
import { toSessionInput, type SessionCandidate } from './lib/sessions.ts';
import { createMultiRun } from './lib/multi-run.ts';
import { setupAnalyticsEffects } from './lib/analytics-integration.ts';
import { sessionBoundaries, sessionOfFrame } from './lib/frame-source.ts';
import { supportsDirectoryPicker } from './lib/directory-picker.ts';
import { ProjectView } from './components/ProjectView.tsx';
import { createProjectStore, type ProjectOpen } from './lib/project-store.ts';
import type { RunFile } from '@calab/project';
import {
  createIndexedDbRecentStore,
  rememberProject,
  type RecentProject,
} from './lib/recent-projects.ts';
import { LIBRARY_MODE_LABEL } from './lib/session-run.ts';
import { createLookbackClient } from './lib/lookback-client.ts';
import { loadSpeedSettings } from './lib/speed-track.ts';
import { presetCurve } from './lib/speed-schedule.ts';
import { PACE_BATCH, PACE_SLACK } from './lib/frame-pacer.ts';
import { FLOOR, TRACKER } from './lib/speed-floor.ts';
import { LOOKBACK } from './lib/slow-runner.ts';
import { CSETTLE, noiseMap, SETTLE, settleChange, unitFootprints } from './lib/settle.ts';
import { GOVERNOR } from './lib/settle-governor.ts';
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
import { DonatePanel, MyDonationsEntry } from './components/DonatePanel.tsx';
import { BrowseDonationsEntry } from './components/BrowseDonations.tsx';
import { createDonationStore } from './lib/donation-store.ts';
import type { DonationSource } from './workers/donation-types.ts';
import { errMsg } from './lib/errors.ts';

const App: Component = () => {
  // Magic-link redirect: show the sign-in confirmation instead of the app.
  // `isAuthCallback()` inspects window.location at mount time; the URL
  // doesn't change within a single component lifetime, so the early
  // return is safe.
  // A donation sign-in link (its own Supabase project) is confirmed against that project.
  // eslint-disable-next-line solid/components-return-once
  if (isDonationAuthReturn()) {
    return (
      <AuthCallback user={donationUser} loading={donationAuthLoading} error={donationAuthError} />
    );
  }
  // eslint-disable-next-line solid/components-return-once
  if (isAuthCallback()) return <AuthCallback user={user} loading={authLoading} />;

  // The page's URL flags, read once (`lib/page-flags.ts`).
  const flags = parsePageFlags(window.location.search);
  // The workers (and the files they hold) live as long as the app.
  const client = createFrameClient(undefined, {
    // `?gpu=0`: WASM motion correction (to compare with WebGPU).
    gpu: flags.gpu,
  });
  const store = createViewerStore(client);
  // The run's history over stream time: fed by the cell and pipeline stores, read by the History views.
  const runHistory = createRunHistory();
  const historyUi = createHistoryUi(runHistory);
  const cells = createCellStore(undefined, undefined, runHistory);
  // Cell discovery runs in a worker of its own, fed directly by the frame
  // worker, with its tile visits spread over the spare cores.
  // `?visits=N`: that many visit workers (0 = the slow worker visits itself).
  // `?review` (with `?compress`): the history review, every 8 compressed windows
  // (`?review=N`: every N), in a worker of its own. One core is left for it.
  // A live stream settles and extracts on the factors Discover writes, and a recording
  // on the factors the GPU compresses while Discover runs, by default (`?factors=0`: off;
  // `?compress&review` turns it off for the review). On a recording `?factors` runs as
  // with `?compress`, and `?factors=file` compresses on the CPU.
  const pageFactors = flags.factors;
  if (pageFactors.warn) console.warn(pageFactors.warn);
  const reviewWindows = pageFactors.review ? reviewEvery(flags.review) : null;
  // The visit workers, the settle pool and the compress pool from one core count
  // (`lib/thread-budget.ts`). The settle pool: S more look-back workers that take only the
  // settle's chunks (worker 0 keeps need-driven look-back and the end settle), started when a
  // run first goes below Max; `?debug&lbpool=S` overrides S (measurement). The compress pool: a
  // recording's windows are compressed by the compress worker and its helpers, few while
  // Discover reads and more after its last frame; `?debug&cpool=D,E` sets both (measurement).
  const threads = threadBudget(
    typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined,
    {
      visits: flags.visits,
      review: reviewWindows !== null,
      lbpool: flags.lbpool,
      cpool: flags.cpool,
    },
  );
  const slow = createSlowClient(
    client,
    (msg) => cells.onSlowMessage(msg),
    undefined,
    threads.visitWorkers,
  );
  // `?noqc`: run without online quality control (to measure its cost).
  // `?compress`: also compress the preprocessed frames into low-rank factors, window by
  // window, in a worker of its own (windows and factors are files in OPFS).
  const compress = pageFactors.compressWorker ? createCompressStore(cells) : undefined;
  // The review worker gets the factors from the compress worker; the cells it
  // finds go to the slow loop, which takes them on probation.
  const review =
    reviewWindows === null
      ? undefined
      : createReviewStore(reviewWindows, (session, candidates) =>
          slow.addReviewed(session, candidates),
        );
  const reviewClient = review ? createReviewClient((msg) => review.onMessage(msg)) : undefined;
  const lbPool = threads.settlePool;
  const cpool = threads.compressPool;
  const compressHelpers = helpersFor(cpool);
  const compressClient = compress
    ? createCompressClient(
        client,
        (msg) => compress.onMessage(msg),
        undefined,
        review && reviewClient ? { port: reviewClient.port, every: review.every } : undefined,
        compressHelpers > 0 ? { count: compressHelpers } : undefined,
      )
    : undefined;
  // Look-back: Discover refines footprints as it goes by re-reading past frames in a
  // worker of its own, and settles at the end (the Final settle).
  // A recording on disk (one session or a Joint run of several) only.
  const lookbackClient = createLookbackClient({
    slow,
    pool: lbPool,
    source: () => store.source(),
    blocked: () => {
      const i = store.info();
      if (!i) return 'Open a recording first.';
      if (i.live) return 'Look-back needs a recording on disk (not a live stream).';
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
    flags.flatFieldOff ? { flatField: false } : {},
    undefined,
    cells,
    !flags.noqc,
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
          ...(!i.live && Number.isFinite(i.frameCount) ? { frames: i.frameCount } : {}),
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
    // Workers ended after the previous run (`releaseAfterDiscover`, `releaseAfterExtract`).
    async () => {
      compressClient?.helpersReady();
      await slow.ready();
    },
  );
  // The Speed block's saved settings (mode, last Fixed speed, Background settle cap); the URL
  // parameters below win for this page.
  const speed = loadSpeedSettings();
  if (speed.mode === 'fixed') pipeline.setPaceFps(speed.fixedFps, 'setting');
  if (speed.mode === 'curve')
    pipeline.setSpeedCurve(presetCurve(speed.preset), { preset: speed.preset });
  if (speed.mode === 'auto') pipeline.setAutoBudget(speed.autoBudget);
  if (speed.cap === 0) pipeline.setCsettle(false);
  else pipeline.setCsettleCeiling(speed.cap);
  // Look-back (with its Final settle) is on by default for recordings; `?lookback=0` turns it off.
  if (flags.lookbackOff) pipeline.setLookback(false);
  if (pageFactors.factors) pipeline.setFactors(true);
  pipeline.setFactorsDefault(pageFactors.factorsDefault);
  pipeline.setCompressAsked(pageFactors.compressAsked);
  pipeline.setCompressPool(cpool);
  // `?debug&cbacklog=GB`: the cap on window files waiting for compression (measurement).
  if (flags.cbacklogGb > 0) pipeline.setCompressBacklogCap(flags.cbacklogGb * 2 ** 30);
  // `?debug&fextract=0`: Extract on factors on rebuilt frames, (measurement).
  pipeline.setFrameExtract(flags.frameExtract);
  // `?debug&lbpoolmax`: the settle pool starts at Max too (measurement: the pooled Final settle at Max).
  pipeline.setPoolAtMax(flags.poolAtMax);
  if (pageFactors.factorsFile)
    pipeline.setFactorsFile(true, () => {
      const s = store.source();
      return s !== null && 'sessions' in s;
    });
  pipeline.setFactorsGpu(pageFactors.factorsGpu);
  // `?debug&gpucheck=N`: the GPU's factors of the first N windows against the CPU's (measurement).
  pipeline.setGpuCheck(flags.gpucheck > 0 ? flags.gpucheck : 0);
  // Background settle (settle during Discover) is on under look-back whenever the target is
  // below Max; `csettle=0` turns it off, `csettle=yield` or `csettle=yieldN` feeds each answer
  // N frames at a time (1 by default), `csrate=1|0.5` lowers the cap from 2 re-read frames
  // per live frame.
  // The URL decides the settle when it says anything about it, over the Speed block's saved cap.
  if (flags.csettle) {
    pipeline.setCsettle(flags.csettle.on, 'url');
    if (flags.csettle.yield !== null) pipeline.setCsettleYield(flags.csettle.yield);
    if (flags.csettle.ceiling !== null) pipeline.setCsettleCeiling(flags.csettle.ceiling, 'url');
  }
  // `?debug&needfirst` (measurement only): with one look-back worker, need-driven look-back
  // goes first and Background settle asks only when it has nothing to ask.
  if (flags.needFirst) pipeline.setCsettleNeedFirst(true);
  // `?debug&repeatable=0` (measurement only): results applied as they arrive, as for a live stream.
  if (flags.repeatableOff) pipeline.setRepeatable(false);
  // `?debug&visitrate=off|auto` (measurement only): no Discover visit cap and no hold (the
  // behaviour before the fixed visit rate), or the opt-in Auto schedule instead of the fixed rate (`lib/visit-rate.ts`).
  if (flags.visitRate !== null) pipeline.setVisitRateSetting(flags.visitRate);
  // `?debug&settlevisits=R` (measurement only): the Final settle's visit rate, visits per settle
  // frame; `off` hands out visits whenever a visit worker is free (the behaviour before).
  if (flags.settleVisits !== null) pipeline.setSettleVisitRate(flags.settleVisits);
  // `?debug&pacefps=30` (measurement only): read the recording at a stream's rate.
  if (flags.paceFps !== null) pipeline.setPaceFps(flags.paceFps, 'url');
  // `?debug`: log the time of each displayed frame change; `smooth=0` turns smooth playback off.
  if (flags.debug) {
    pipeline.setDisplayLog(true);
    if (flags.smoothOff) pipeline.setSmoothPlayback(false);
  }
  // ---- Run stages (docs/stages.md): Discover (look-back and Final settle), Extract ----
  const stageLog = createStageLog();
  const discoverActivity = (): StageActivity => {
    const st = pipeline.status();
    return st === 'starting' || st === 'paused' ? 'running' : st;
  };
  const stageInput = () => ({
    live: store.info()?.live !== undefined,
    discover: discoverActivity(),
    extract: pass2.status(),
    finalLibrary: cells.status()?.final ?? false,
    cells: cells.library()?.ids.length ?? 0,
    replayBlocked: pipeline.factorRun() ? null : replayBlocked(pipeline),
    liveFactors: pipeline.factorRun(),
  });
  const availability = () => stageAvailability(stageInput());
  // `?factors`: Extract on a stream solves in the compress worker, on the factors.
  const factorExtract =
    compress && compressClient
      ? createFactorExtract(
          compress,
          compressClient,
          () => cells.session(),
          () => pipeline.factorRun(),
          () => pipeline.status() === 'done',
          () => pipeline.processed(),
          () => pipeline.factorFileRun(),
        )
      : undefined;
  const pass2 = createPass2Store(client, pipeline, cells, undefined, factorExtract);
  // ---- Workers with no job left: ending a worker is what returns its WASM memory ----
  // Once Discover's final library is out, nothing talks to the slow worker, its visit workers or
  // the look-back workers until the next Discover start: Extract solves with the library the main
  // thread holds, and the export reads the slow loop's last status kept here. They end now, before
  // Extract's memory peak; the next start brings them back (`workersReady` above).
  let releasedFor = 0;
  createEffect(() => {
    const session = cells.session();
    if (cells.status()?.final !== true || session === releasedFor) return;
    releasedFor = session;
    lookbackClient.release?.();
    slow.release();
  });
  // A finished Extract on factors leaves the compress helpers nothing to do until the next run,
  // back-fill or Extract (`helpersReady`).
  createEffect(
    on(
      () => pass2.status(),
      (st) => {
        if (st === 'done' && untrack(pass2.result)?.source === 'factors')
          compressClient?.releaseHelpers();
      },
    ),
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
  // Discover: a new run starts the stage log over; it ends with the final library.
  createEffect(
    on(
      () => pipeline.status(),
      (st) => {
        if (st === 'starting') {
          stageLog.reset();
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
      ...(pipeline.lookbackRun() ? { lookback: true } : {}),
      ...(slow?.lookback?.settle?.source === 'factors' ? { settleSource: 'factors' as const } : {}),
      ...(slow?.lookback?.settle?.source === 'file'
        ? { settleSource: 'file' as const, settleSourceReason: slow.lookback.settle.fileReason }
        : {}),
    };
    // A factor run's compress pool (format 7 only: with a settle source).
    const cs = compress?.status();
    if (data.settleSource && cs) {
      const pool = pipeline.runPool();
      data.compress = {
        workers: pool?.discover ?? 1,
        workersAfter: pool?.after ?? 1,
        behindFrames: cs.behindAtEnd ?? null,
        backlogPeakBytes: cs.backlogPeakBytes ?? 0,
        fpsAfter: cs.fpsAfter ?? null,
        ...(cs.window !== undefined ? { window: cs.window } : {}),
        ...(cs.ring !== undefined ? { ring: cs.ring } : {}),
        ...(cs.backend ? { backend: cs.backend } : {}),
        ...(cs.waitS !== undefined ? { waitS: cs.waitS, waits: cs.waits ?? 0 } : {}),
      };
    }
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
    const run = pipeline.runParams();
    if (!r || !run) return null;
    const backend = await loadSpanStats(run.json);
    // A session's own rate when its file has one, else the run's (the params' fallback).
    const rate = fps > 0 ? fps : run.engine.fps;
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
            ...(r?.source === 'factors'
              ? {
                  source: 'factors' as const,
                  factors: r.factors,
                  ...(r.extractor ? { extractor: r.extractor } : {}),
                }
              : {}),
            ...(r?.source === 'file'
              ? { source: 'file' as const, sourceReason: r.sourceReason }
              : {}),
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
    // A ?factors stream's Extract solves on the factors; the back-fill would replace the live traces.
    if (pipeline.factorRun() || pipeline.factorFileRun()) return;
    if (compress?.takeBackfill(done, slow?.final ?? false, slow?.version ?? 0)) {
      compressClient?.backfill(cells.session(), slow?.version ?? 0);
    }
  });
  // A factor run: when the slow loop waits for the factors, begin the settle on them or end
  // the wait; a watchdog gives up on a compressor that stopped.
  if (compress) {
    const factorSettle = new FactorSettle();
    const fileChoice = new FileSettleChoice();
    const watchdog = new FactorWatchdog();
    const [tick, setTick] = createSignal(0);
    const timer = setInterval(() => setTick((n) => n + 1), 5000);
    onCleanup(() => clearInterval(timer));
    createEffect(() => {
      tick();
      const st = cells.status();
      const session = cells.session();
      const ended = pipeline.status() === 'done';
      const frames = pipeline.processed();
      const waiting = st?.lookback?.settle?.waiting === true;
      const now = performance.now();
      if (waiting) {
        watchdog.note(compress.status(), now);
        const stallState = pipeline.factorFileRun()
          ? compress.fileFactors(ended, frames)
          : compress.factors(ended, frames);
        if (watchdog.stalled(now) && stallState === 'compressing') {
          compress.fail(FACTOR_STALL_TEXT);
          runHistory.log({ frame: frames, kind: 'warning', detail: FACTOR_STALL_TEXT });
        }
      } else watchdog.reset();
      const state = compress.factors(ended, frames);
      const i = store.info();
      const a = factorSettle.act({
        session,
        factorRun: pipeline.factorRun(),
        waiting,
        final: st?.final === true,
        state,
        reason: factorsBlocked(state, compress.status(), compress.error()),
        info: compress.factorInfo(),
        width: i?.width ?? 0,
        height: i?.height ?? 0,
      });
      if (a.kind === 'begin') {
        lookbackClient.beginFactors?.(a.session, a.factors);
        const run = pipeline.runParams();
        if (run) lookbackClient.params(a.session, run.json);
        slow.factorsReady(a.session, a.frames);
      } else if (a.kind === 'fail') slow.factorsFailed(a.session, a.reason);
      else if (a.kind === 'release') lookbackClient.reset(a.session);
      const fileState = compress.fileFactors(ended, frames);
      const f = fileChoice.act({
        session,
        factorFile: pipeline.factorFileRun(),
        waiting,
        state: fileState,
        reason: fileFactorsBlocked(fileState, compress.status(), compress.error(), frames),
        info: compress.factorInfo(),
        behind: compress.behind(frames),
        window: pipeline.runParams()?.engine.factors.window_frames ?? 0,
        msPerFrame: compress.status()?.msPerFrame ?? 0,
        workers: pipeline.runPool()?.after ?? 1,
        // A GPU run is never more than a window and its slack behind: wait for its last window.
        wait: flags.fwait || pipeline.gpuFactorRun(),
        width: i?.width ?? 0,
        height: i?.height ?? 0,
      });
      if (f.kind === 'factors') {
        slow.factorsReady(f.session, f.frames, f.factors);
        // The Final settle on the factors runs on the settle pool too, at Max as well (after
        // `factorsReady`, so the slow worker switches the joining workers to the factors).
        pipeline.startFactorPool(f.session, f.factors);
      }
      // The final library is out: the pool started for the Final settle ends before Extract.
      if (st?.final === true) pipeline.endFactorPool(session);
      else if (f.kind === 'file') {
        slow.factorsFailed(f.session, f.reason);
        // No stage reads the factors now: free the CPU and the disk for the file's settle and Extract.
        compressClient?.stop(f.session);
        compress.fail(STOPPED_TEXT);
        runHistory.log({
          frame: frames,
          kind: 'warning',
          detail: `Final settle re-reads the file: ${f.reason}`,
        });
      }
    });
  }
  // `?debug`: expose the stores for measurement scripts (timing, lag, library events).
  let discoverEnd: {
    session: number;
    library: Pick<
      LibraryView,
      'version' | 'frame' | 'width' | 'height' | 'ids' | 'starts' | 'pixels' | 'values'
    >;
  } | null = null;
  if (flags.debug) {
    (globalThis as { __cala?: unknown }).__cala = {
      cells,
      pipeline,
      pass2,
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

  // ---- Data donation (docs/data-donation.md): only with a donation backend ----
  const donation = donationEnabled ? createDonationStore() : null;
  // Follow the donation sign-in from the start (its own project, if configured),
  // so a sign-in completed in another tab shows up here.
  if (donation) initDonationAuth();
  /** The open recording's files, for a donation (null: live, or nothing open). */
  const [donationSource, setDonationSource] = createSignal<DonationSource | null>(null);

  /** The session whose recording is open on its own (null: none, a Joint run's, or a stream). */
  let openCandidate: SessionCandidate | null = null;
  // Opening a session loads its recording and nothing else: a one-session project shows the Run
  // tab's pre-run sheet, and Discover starts on its Run button. The previous recording's Extract
  // result, stage log, run history and export mark are dropped, so nothing of it shows or exports
  // under the new label.
  async function openRecording(candidate: SessionCandidate, label: string) {
    pipeline.stop();
    pass2.clear();
    stageLog.reset();
    clearResultExported();
    openCandidate = null;
    await store.openFiles(candidate.entries, label);
    const info = store.info();
    if (info) {
      openCandidate = candidate;
      runHistory.reset({
        fps: info.fps ?? 0,
        live: false,
        frameCount: info.frameCount,
        workers: 0,
      });
    }
    setDonationSource(info ? { entries: candidate.entries } : null);
  }

  // ---- Runs of plan steps (docs/stages.md, "Sessions") ----
  /** The start screen, or the project table. A one-session project opens on its recording. */
  const [screen, setScreen] = createSignal<'open' | 'project'>('open');
  const version = import.meta.env.VITE_APP_VERSION || 'dev';
  // ---- Run record (docs/run-record.md): how this run was made, saved with every result ----
  const runTrace = new RunTrace();
  pipeline.onPaceChange((fps, frame, source) => runTrace.noteTargetSpeed(fps, frame, source));
  pipeline.onCapChange((cap, frame, source) => runTrace.noteCap(cap, frame, source));
  pipeline.onPoolStart((workers, frame, forFinal) =>
    runTrace.notePoolStart(workers, frame, forFinal),
  );
  pipeline.onWorkSample((sample) => runTrace.noteSample(sample));
  // A curve that takes over mid-run replaces the one noted at the start.
  pipeline.onCurveArmed((curve) => runTrace.noteCurve(curve));
  // Auto's budget and decisions are kept in the trace, so changing Speed after the run does not lose them.
  pipeline.onAutoChange((a) => runTrace.noteAuto(a));
  // The Discover visit rate's summary (floor, target, cap, achieved, time held).
  pipeline.onVisitRate((s) => runTrace.noteVisitRate(s));
  // A Discover start begins a new run: the target speed in force is its first entry.
  createEffect(
    on(
      () => pipeline.status() === 'starting',
      (starting) => {
        if (!starting) return;
        runTrace.reset();
        // What is applied: a live stream is not paced by a target, and has no settle.
        runTrace.noteTargetSpeed(pipeline.targetNow(), 0, 'run start');
        runTrace.noteCap(pipeline.capNow(), 0, 'run start');
        // The curve armed at the start (before this reset) is the run's.
        runTrace.noteCurve(pipeline.curveNow());
        runTrace.noteAuto(pipeline.autoNow());
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
      lookbackRun: pipeline.lookbackRun,
      repeatableRun: pipeline.repeatableRun,
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
    // The engine values among them come from the run's resolved params.
    tunables: () => {
      const e = pipeline.runParams()?.engine;
      return {
        settle: { ...SETTLE, maxFrames: e?.settle.final_max_frames ?? null },
        csettle: CSETTLE,
        governor: GOVERNOR,
        lookback: {
          ...LOOKBACK,
          jointUpdate: e?.slow_loop.joint_update ?? null,
          jointSign: e?.slow_loop.joint_sign_rule ?? null,
          mergeGuardMinSep: e ? (e.slow_loop.merge_guard_min_sep ?? Infinity) : null,
          rate: e?.lookback.rate ?? null,
          maxFrames: e?.lookback.max_frames ?? null,
        },
        pacer: { PACE_BATCH, PACE_SLACK },
        floor: { FLOOR, TRACKER },
      };
    },
    params: () => pipeline.runParams(),
    request: () => pipeline.runRequest(),
  };
  const runRecord = (extras?: RunRecordExtras) => gatherRunRecord(runRecordSources, extras);
  // A live run's traces, once it has ended: what its run writes when it has no Extract.
  const liveResult = createLiveResult(pipeline, cells, () => store.info()?.live !== undefined);
  const liveState = (): LiveResultState | null => {
    if (!store.info()?.live) return null;
    if (liveResult.result()) return 'ready';
    const ended = pipeline.status() === 'done' && (cells.status()?.final ?? true);
    return ended && (cells.library()?.ids.length ?? 0) === 0 ? 'empty' : 'waiting';
  };
  const multiRun = createMultiRun({
    runRecord: (kind) => runRecord({ mode: kind }),
    liveResult: liveState,
    async openJoint(sessions) {
      pipeline.stop();
      openCandidate = null;
      const n = sessions.length;
      const inputs = sessions.map((s) => toSessionInput(s.candidate));
      await store.openSessions(
        inputs,
        `${sessions[0].candidate.name} + ${n - 1} more (${n} sessions)`,
      );
      setDonationSource(store.info() ? { sessions: inputs } : null);
      if (store.info()) void pipeline.start();
    },
    async openOne(session, index) {
      if (session.live) {
        await connectLive(session.live);
        return;
      }
      const n = multiRun.plan()?.sessions.length ?? 1;
      // The recording a one-session project shows before its Run is already open.
      if (openCandidate === session.candidate && store.info()) pipeline.stop();
      else
        await openRecording(
          session.candidate,
          n === 1
            ? (project.opened()?.rootName ?? session.candidate.name)
            : `Session ${index + 1} of ${n}: ${session.candidate.name}`,
        );
      if (store.info()) void pipeline.start();
    },
    stages: () => ({
      discover: discoverActivity(),
      extract: pass2.status(),
      availability: availability(),
      runs: stageLog.runs(),
    }),
    runExtract: () => void pass2.run(),
    sessionQc: (range, fps) => extractQcFor(range, fps),
    boundaryFlags: () => pipeline.boundaryFlags(),
    exportInput: (): ExportInput | null => {
      const i = store.info();
      const r = pass2.result() ?? (i?.live ? liveResult.result() : null);
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
    project: () => project.summary(),
    throughput: (stage) => (stage === 'discover' ? pipeline.fps() : pass2.fps()),
    stageError: (stage) => (stage === 'discover' ? pipeline.error() : pass2.error()),
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
        error: `This result could not be opened: ${errMsg(err)}`,
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

  // A run writes its run file before its first frame.
  pipeline.setBeforeFrames(() => multiRun.beforeFrames());
  /** The run file a manual export carries: the run's own (null: no run has started). */
  const exportRunFile = (): RunFile | null => multiRun.runFile();

  /**
   * Open what was picked (`docs/projects.md`): the project's files are read or made in memory; a
   * one-session project opens on its recording (the pre-run sheet), a larger one on its table.
   */
  async function openProject(o: ProjectOpen): Promise<void> {
    setScreen('project');
    await project.open(o);
    loadRecent();
    const one = project.single();
    if (!one || project.error()) return;
    await openRecording(one.candidate, o.rootName);
    if (!store.info()) {
      project.close();
      setScreen('open');
    }
  }

  /** Run: the open recording's run, a new run of its project step (inside the click). */
  function runOpen(): void {
    const one = project.single();
    if (one) void project.runStreams([one.planned.stream]);
  }

  /**
   * Restart: Discover again from frame 0. While a run is going it is the same run; once it has
   * ended it is a new run of the same streams (Separate: the session that is open).
   */
  function restart(): void {
    const p = multiRun.plan();
    if (p && !multiRun.finished() && !multiRun.stopped()) {
      void pipeline.start();
      return;
    }
    const refs = p
      ? p.kind === 'joint'
        ? p.sessions.map((x) => x.stream)
        : [p.sessions[multiRun.current()].stream]
      : project.single()
        ? [project.single()!.planned.stream]
        : [];
    if (refs.length > 0) void project.runStreams(refs, p?.kind === 'joint' ? 'joint' : 'separate');
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
  if (flags.debug) {
    Object.assign((globalThis as { __cala?: object }).__cala ?? {}, {
      multiRun,
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
        if (a.repeatable !== undefined) pipeline.setRepeatable(a.repeatable);
        if (a.finalSettleLevel !== undefined) pipeline.setFinalSettleLevel(a.finalSettleLevel);
        if (a.paceFps !== undefined) pipeline.setPaceFps(a.paceFps, 'run record');
        // A Curve or Auto run replays as a curve: exactly its realised steps (the pace above is
        // only where it began).
        if (a.curve) pipeline.setSpeedCurve(a.curve, { preset: 'replay', normalize: false });
        if (a.smoothPlayback !== undefined) pipeline.setSmoothPlayback(a.smoothPlayback);
        // The pool size is fixed at page load: say so rather than run differently in silence.
        const warnings: string[] = [];
        if (a.refineUsed)
          warnings.push(
            'The record ran a Refine stage, which has been removed: look-back and the Final settle replace it, so look-back is kept on for this replay and no Refine run happens.',
          );
        if (a.capChangedDuringRun)
          warnings.push(
            'The record changed the settle cap during the run; cap changes are not replayed (the starting cap is applied).',
          );
        if (a.lookbackPoolPlanned !== undefined && a.lookbackPoolPlanned !== lbPool)
          warnings.push(
            `The record planned ${a.lookbackPoolPlanned} settle pool worker(s); this page has ${lbPool} (open it with ?debug&lbpool=${a.lookbackPoolPlanned} to match).`,
          );
        for (const w of warnings) console.warn(w);
        return warnings.length > 0 ? { ...a, warnings } : a;
      },
    });
  }
  const boundaries = () => {
    const i = store.info();
    return i ? sessionBoundaries(i) : [];
  };
  /** Connect to a live source and start Discover: its frames arrive whether or not a run reads them. */
  async function connectLive(url: string) {
    pipeline.stop();
    openCandidate = null;
    setDonationSource(null);
    await store.openLive(url);
    if (store.info()) void pipeline.start();
  }
  /**
   * A live stream is a one-session project with no folder (`?live=<url>` connects on load): its
   * run starts at once, and its files go into a zip at the end.
   */
  async function openLive(url: string) {
    await project.open({ rootName: 'live stream', entries: [], handle: null, sessions: [], live: url });
    if (!(await project.runStreams(['.']))) setScreen('project');
  }
  const liveParam = flags.live;

  /** "Session 3/8" in a run of several sessions: the session being read (Joint: the one the frame is in). */
  const sessionLabel = (): string | null => {
    const p = multiRun.plan();
    if (!p || p.sessions.length < 2) return null;
    const n = p.sessions.length;
    if (p.kind !== 'joint') return `Session ${multiRun.current() + 1}/${n}`;
    const info = store.info();
    return `Session ${(info ? sessionOfFrame(info, pipeline.processed()) : 0) + 1}/${n}`;
  };

  /** The rail's session ribbon: each session's state in a multi-session run (null: not one). */
  const railSessions = (): { label: string; items: RailSession[] } | null => {
    const label = sessionLabel();
    const p = multiRun.plan();
    if (!label || !p) return null;
    const joint = p.kind === 'joint';
    const info = store.info();
    const now = joint
      ? info
        ? sessionOfFrame(info, pipeline.processed())
        : 0
      : multiRun.current();
    return {
      label,
      items: multiRun.records().map((r) => ({
        name: r.name,
        status: `${r.status}${r.note ? ` (${r.note})` : ''}`,
        state:
          r.status === 'written'
            ? 'done'
            : r.status === 'failed'
              ? 'error'
              : r.status === 'skipped'
                ? 'off'
                : r.index === now
                  ? 'running'
                  : r.index < now
                    ? 'done'
                    : 'waiting',
      })),
    };
  };

  /** A session's state word and badge tone in the session list. */
  const sessionBadge = (r: { status: string; index: number }, current: boolean, read: boolean) => {
    if (r.status === 'written')
      return { tone: 'neutral' as const, icon: 'check' as const, word: 'written' };
    if (r.status === 'failed')
      return { tone: 'critical' as const, icon: undefined, word: 'failed' };
    if (r.status === 'skipped')
      return { tone: 'neutral' as const, icon: undefined, word: 'skipped' };
    if (current) return { tone: 'discover' as const, icon: undefined, word: 'running' };
    // A Joint run writes every session at its end; a session Discover has read past is read.
    if (read) return { tone: 'neutral' as const, icon: 'check' as const, word: 'read' };
    return { tone: 'neutral' as const, icon: undefined, word: r.status };
  };

  /** A multi-session run's state, in the Run tab under the Run panel. */
  function SessionRunStatus() {
    return (
      <Show when={multiRun.plan()}>
        {(p) => {
          const joint = () => p().kind === 'joint';
          const nowIndex = () => {
            const info = store.info();
            return joint()
              ? info
                ? sessionOfFrame(info, pipeline.processed())
                : 0
              : multiRun.current();
          };
          const written = () => multiRun.records().filter((r) => r.status === 'written').length;
          return (
            <section class="cala-session-run" data-testid="session-run" aria-label="Sessions">
              <div class="cala-session-run__head">
                <h3 class="cala-session-run__title">Sessions</h3>
                <Badge tone="neutral">{LIBRARY_MODE_LABEL[p().kind]}</Badge>
                <span class="cala-session-run__status" data-testid="session-run-status">
                  {multiRun.statusText()}
                </span>
              </div>
              <MeterRow
                label="Results written"
                value={written()}
                min={0}
                max={Math.max(1, p().sessions.length)}
                display={`${written()} / ${p().sessions.length}`}
                size="sm"
                format={(v) => `${v} of ${p().sessions.length} sessions written`}
              />
              <Show when={project.running() && project.planState().kind === 'running'}>
                <MeterRow
                  label="Plan groups"
                  value={(project.planState() as { step: number }).step + 1}
                  min={0}
                  max={Math.max(1, project.running()!.length)}
                  display={`${(project.planState() as { step: number }).step + 1} / ${project.running()!.length}`}
                  size="sm"
                  testid="plan-progress"
                  format={(v) => `Plan: step ${v} of ${project.running()!.length}`}
                />
              </Show>
              <ol class="cala-session-run__list">
                <For each={multiRun.records()}>
                  {(r) => {
                    const current = () =>
                      r.status !== 'written' &&
                      r.status !== 'failed' &&
                      r.status !== 'skipped' &&
                      r.index === nowIndex() &&
                      pipeline.status() !== 'idle';
                    const badge = () =>
                      sessionBadge(
                        r,
                        current(),
                        joint() && r.status === 'pending' && r.index < nowIndex(),
                      );
                    return (
                      <li
                        class="cala-session-run__item"
                        classList={{ 'cala-session-run__current': current() }}
                        data-testid="session-run-item"
                      >
                        <span class="cala-session-run__index num">{r.index + 1}</span>
                        <span class="cala-session-run__name" title={r.name}>
                          {r.name}
                        </span>
                        <Badge tone={badge().tone} icon={badge().icon} title={r.note ?? undefined}>
                          {badge().word}
                        </Badge>
                        <Show when={r.note}>
                          <span class="cala-session-run__note">{r.note}</span>
                        </Show>
                        <Show
                          when={
                            joint() && pipeline.boundaryFlags().find((f) => f.index === r.index)
                          }
                        >
                          {(f) => <BoundaryBadge flag={f()} />}
                        </Show>
                      </li>
                    );
                  }}
                </For>
              </ol>
              <Show when={multiRun.root()}>
                {(root) => (
                  <p class="cala-session-run__root" data-testid="session-run-root">
                    Results:{' '}
                    <span class="cala-session-run__path">
                      {p().locationLabel}
                      {root()}/
                    </span>
                  </p>
                )}
              </Show>
            </section>
          );
        }}
      </Show>
    );
  }

  /**
   * One screen, no page scroll: the field of view, square-ish and as tall as
   * the window, on the left; on the right the run rail over one row of tabs
   * (Run, Cell, QC, History, details), one panel with the column's height.
   * Narrow windows stack rail, image and tabs, in that order, and scroll. The
   * rail is one element in both layouts (CSS places it), so its history stays.
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
              stages={stageLog}
              availability={availability()}
              cells={cells}
              live={lp.info.live !== undefined}
              liveResult={liveResult.result}
              fps={lp.info.fps ?? 0}
              frameWidth={lp.info.width}
              ui={historyUi}
              factorRun={pipeline.factorRun()}
              compress={pipeline.compressRun() ? compress : undefined}
              review={review}
              onStopSettling={() => slow.stopSettling(cells.session())}
              sessionMode={multiRun.plan()?.kind ?? null}
              sessions={multiRun.plan()?.sessions.length ?? 1}
              onRun={runOpen}
              onRestart={restart}
              visible={tab.active() === 'run'}
            />
            <SessionRunStatus />
            {/* Donate data: a recording opened from files, with a community backend. */}
            <Show when={donation && !lp.info.live}>
              <DonatePanel
                donation={donation!}
                info={lp.info}
                source={donationSource()}
                label={store.label()}
                version={version}
              />
            </Show>
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
    // A recording opened for a new run shows the Run tab, where its pre-run sheet and Run are.
    if (
      untrack(pipeline.status) === 'idle' &&
      !untrack(multiRun.plan) &&
      !untrack(() => lp.info.live)
    )
      tab.show('run');
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
        <div class="cala-main__rail">
          <RunRail
            pipeline={pipeline}
            pass2={pass2}
            cells={cells}
            live={lp.info.live !== undefined}
            fps={lp.info.fps ?? 0}
            sessions={railSessions()}
            onStopSettling={() => slow.stopSettling(cells.session())}
            export={
              <ExportMenu
                pipeline={pipeline}
                pass2={pass2}
                cells={cells}
                stages={stageLog}
                ui={historyUi}
                live={lp.info.live !== undefined}
                liveResult={liveResult.result}
                liveError={liveResult.error}
                label={store.label()}
                width={lp.info.width}
                height={lp.info.height}
                fps={lp.info.fps ?? 0}
                bitDepth={lp.info.bitDepth}
                runFile={exportRunFile}
              />
            }
          />
        </div>
        <div class="cala-main__side">
          <SideColumn tabs={tabs} active={tab.active()} onActive={tab.set} />
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
                {v.result.width} &times; {v.result.height}
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
              <ThemeToggle />
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
            when={screen() === 'project'}
            fallback={
              <>
                <OpenFolder
                  onProject={(o) => void openProject(o)}
                  onAnimals={(handles) =>
                    void (async () => {
                      for (const h of handles)
                        await rememberProject(recentStore, h, null, new Date());
                      loadRecent();
                    })()
                  }
                  recent={supportsDirectoryPicker() ? recent() : []}
                  onForget={(r) => void recentStore.remove(r.id).then(loadRecent)}
                  loading={store.loading() || project.loading()}
                  error={store.error() ?? project.error()}
                  onOpenLive={(url) => void openLive(url)}
                  liveUrl={liveParam ?? undefined}
                />
                <Show when={donation && screen() === 'open'}>
                  <>
                    <MyDonationsEntry donation={donation!} />
                    <BrowseDonationsEntry />
                  </>
                </Show>
              </>
            }
          >
            <>
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
                pipeline={pipeline}
                onView={(r) => void viewResult(r)}
                onClose={() => {
                  setViewState({ busy: false, error: null });
                  project.close();
                  setScreen('open');
                  loadRecent();
                }}
              />
            </>
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
                      {info().width} &times; {info().height}
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
                        title="The project's session table, its plan and its results (a running plan stops)"
                        onClick={backToProject}
                      >
                        {project.single() ? 'Project' : 'Back to project'}
                      </button>
                    </Show>
                    <button
                      class="btn-secondary btn-small"
                      onClick={() => {
                        const warn = leaveWarning({
                          extractDone: pass2.status() === 'done',
                          exported: resultExported(),
                          written: multiRun.records().some((r) => r.status === 'written'),
                        });
                        if (warn && !window.confirm(warn)) return;
                        pipeline.stop();
                        multiRun.stop();
                        project.close();
                        setScreen('open');
                        store.close();
                      }}
                    >
                      {info().live ? 'Open another source' : 'Open another folder'}
                    </button>
                    <ThemeToggle />
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
