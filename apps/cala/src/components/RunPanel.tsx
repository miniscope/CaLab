import type { RunRecordExtras } from '../lib/run-provenance.ts';
import { createEffect, createSignal, on, Show, type JSX } from 'solid-js';
import { Icon, SegmentedControl } from '@calab/ui';
import { formatClock, formatElapsed, windowPresets } from '@calab/ui/chart';
import type { ByteSink } from '@calab/io';
import type { CellStore } from '../lib/cell-store.ts';
import { compressReadout, type CompressStore } from '../lib/compress-store.ts';
import { reviewReadout, type ReviewStore } from '../lib/review-store.ts';
import type { PipelineStore } from '../lib/pipeline-store.ts';
import { clearResultExported, markResultExported } from '../lib/export-state.ts';
import { lookbackText } from '../lib/lookback-text.ts';
import type { LibraryMode } from '../lib/session-run.ts';
import { workText } from '../lib/work-meter.ts';
import { errMsg } from '../lib/errors.ts';
export { lookbackText };
import type { Pass2Result, Pass2Store } from '../lib/pass2-store.ts';
import {
  extractAfterDiscover,
  setExtractAfterDiscover,
  LIVE_NOTE,
  NEXT_STEP_HINT,
  showNextStepHint,
  type StageLog,
  type StageName,
} from '../lib/run-stages.ts';
import { AspectPlot } from '../lib/plot-size.tsx';
import { GroupPlot, RunStrip, type HistoryUi } from './HistoryPanel.tsx';
import { liveTraceResult } from '../lib/live-export.ts';
import { FACTORS_LIVE_NOTE, fileFactorNotes } from '../lib/factor-run.ts';
import {
  cadeconCells,
  cadeconIsClassic,
  calaExportBytes,
  FACTORS_EXPORT_NOTE,
  exportFormatVersion,
  factorTailNote,
  fileStem,
  saveExport,
  writeCaDeconExport,
  writeCalaExport,
  type ExportInput,
} from '../lib/export.ts';
import { DiscoverSettings, type SettingsContext } from './DiscoverSettings.tsx';
import { SidePanel } from './SidePanel.tsx';
import { SpeedControl } from './SpeedControl.tsx';
import { WorkDisplay } from './WorkDisplay.tsx';
import { createSteps, ExtractBody, SettleBody, StepPanel, stepOf } from './Steps.tsx';
import { reportResultsExported } from '../lib/analytics-integration.ts';

/** `?debug` is in the URL (read once). */
const DEBUG =
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('debug');

const SETUP_LABEL = {
  calibrate: 'Calibrating (FOV mask, hot pixels)',
  'motion-warmup': 'Building the motion template',
} as const;

/** Badge text and tooltip for where motion correction runs. */
const MOTION_BACKEND = {
  webgpu: ['Motion: WebGPU', 'Motion prefilter and warp run on the GPU.'],
  'wasm-off': ['Motion: CPU', 'WebGPU turned off with ?gpu=0.'],
  'wasm-unavailable': [
    'Motion: CPU',
    'WebGPU is not available in this browser (or cannot run these settings).',
  ],
  'wasm-failed': [
    'Motion: CPU',
    'WebGPU failed during the run; continued on the CPU. See the console.',
  ],
} as const;

export interface RunPanelProps {
  /** The run record (`run-provenance.ts`) with this panel's own settings added; written into each export. */
  runRecord?: (extras: RunRecordExtras) => Record<string, unknown>;
  pipeline: PipelineStore;
  /** The Extract stage (its store keeps the older name). */
  pass2: Pass2Store;
  /** The runs of the stages since Discover started. */
  stages: StageLog;
  /** Why each stage cannot start now (null: it can). */
  availability: Record<StageName, string | null>;
  cells: CellStore;
  /** A live source: Discover only (no file to replay); the stop button ends the stream and the export takes the live traces. */
  live?: boolean;
  /** Recording label (the folder name). */
  label: string;
  width: number;
  height: number;
  /** Frame rate, Hz (0 when unknown). */
  fps: number;
  /** Bits per pixel of the recording (the exported images' display ranges). */
  bitDepth?: number;
  /** The run's history views (shared time window and cursor). */
  ui: HistoryUi;
  /** A live stream with `?factors`: its settle and Extract read the stream's own factors. */
  factorRun?: boolean;
  /** Present when the run compresses its frames (`?compress`). */
  compress?: CompressStore;
  /** Present when the run reviews its compressed history (`?compress&review`). */
  review?: ReviewStore;
  /** False while its tab is hidden: the plots stop drawing (the panel stays mounted for its state). Default true. */
  visible?: boolean;
  /** Stop a look-back run's settling: the footprints refined so far become the final library. */
  onStopSettling?: () => void;
  /** The mode of the multi-session run this recording is part of (null or absent: none). */
  sessionMode?: LibraryMode | null;
}

/**
 * The run: the stages (docs/stages.md) Discover (with look-back and its Final settle for
 * recordings) and Extract (recordings only), with Discover's convergence
 * metrics on one time axis (minutes of the recording) and a "now" line, the
 * run controls and the export. Extract follows Discover only if
 * "Extract after Discover" is turned on (on by default).
 */
export function RunPanel(props: RunPanelProps): JSX.Element {
  const s = () => props.pipeline;
  const c = () => props.cells;
  const p = () => props.pass2;
  // ---- Discover ----
  const statusText = () => {
    const st = s().status();
    if (st === 'starting') return 'Starting';
    if (st === 'error') return 'Stopped by an error';
    if (st === 'done') return props.live ? 'Done' : 'Discover done';
    const setup = s().setup();
    const prefix = st === 'paused' ? 'Paused: ' : '';
    if (s().processed() === 0 && setup) {
      return `${prefix}${SETUP_LABEL[setup.phase]} ${setup.done} / ${setup.total}`;
    }
    return st === 'paused' ? 'Paused' : 'Running';
  };
  const backend = () => {
    if (s().fps() <= 0) return null;
    const b = s().motionBackend();
    if (!b) return null;
    return { key: b, text: MOTION_BACKEND[b][0], title: MOTION_BACKEND[b][1] };
  };
  const pass1Busy = () => s().status() === 'running' || s().status() === 'paused';
  const replayBusy = () => p().status() === 'running';

  const inSessionRun = () => props.sessionMode != null;
  /** When a change to a start-time setting takes effect (`DiscoverSettings`). */
  const settingsContext = (): SettingsContext =>
    props.sessionMode === 'separate' ? 'separate' : props.sessionMode ? 'joint' : 'single';

  // ---- Extract and export ----
  /** Extract runs in this run: a recording, or a stream whose factors it solves on. */
  const extracts = () => !props.live || props.factorRun === true;
  const extractsOnFactors = () => props.live === true && props.factorRun === true;
  const auto = extractAfterDiscover;
  const setAuto = setExtractAfterDiscover;
  const [passOnly, setPassOnly] = createSignal(true);
  const [exporting, setExporting] = createSignal<string | null>(null);
  const [exportError, setExportError] = createSignal<string | null>(null);
  /** Live run: the traces solved as the frames came in, once the run and the final library are in. */
  const [liveResult, setLiveResult] = createSignal<Pass2Result | null>(null);
  createEffect(() => {
    if (!props.live) return;
    const done = s().status() === 'done';
    const final = c().status()?.final ?? true;
    const frames = s().processed();
    c().library();
    if (!done || !final) {
      setLiveResult(null);
      return;
    }
    liveTraceResult(c(), frames, 0).then(setLiveResult, (err: unknown) =>
      setExportError(errMsg(err)),
    );
  });
  const exportResult = () => p().result() ?? liveResult();

  /** Stream one export to disk (see `saveExport`), with progress and errors in the panel. */
  async function runExport(
    name: string,
    sizeHint: number,
    write: (sink: ByteSink, progress: (done: number, total: number) => void) => Promise<void>,
    formatVersion?: number,
  ): Promise<void> {
    setExportError(null);
    setExporting(`Exporting ${name}`);
    try {
      await saveExport(name, sizeHint, (sink) =>
        write(sink, (done, all) =>
          setExporting(`Exporting ${name}: ${all > 0 ? Math.floor((100 * done) / all) : 0}%`),
        ),
      );
      reportResultsExported(1, formatVersion);
      markResultExported();
    } catch (err) {
      setExportError(errMsg(err));
    } finally {
      setExporting(null);
    }
  }

  // A new Discover run invalidates Extract's result.
  createEffect(
    on(
      () => s().status(),
      (st) => {
        if (st === 'starting') {
          p().clear();
          clearResultExported();
        }
      },
    ),
  );
  // Extract follows Discover once the final library is out.
  createEffect(() => {
    if (
      auto() &&
      extracts() &&
      s().status() === 'done' &&
      p().status() === 'idle' &&
      props.stages.runs().every((x) => x.stage === 'discover') &&
      p().blockedReason() === null
    )
      void p().run();
  });

  const pass2Text = () => {
    switch (p().status()) {
      case 'running':
        return (
          p().waiting() ??
          (p().fileReason()
            ? `Extract: re-reading the file (${p().fileReason()})`
            : 'Extract: solving the traces of every frame with the final footprints')
        );
      case 'done': {
        const res = p().result();
        const many = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;
        const windows = res?.extractor
          ? `: ${many(res.extractor.projected, 'window')} projected, ${res.extractor.rebuilt} rebuilt, ${many(res.extractor.workers, 'worker')}`
          : '';
        const from =
          res?.source === 'factors'
            ? props.live
              ? ` (on the stream's factors${windows})`
              : ` (on the factors${windows})`
            : res?.source === 'file'
              ? ` (re-read the file: ${res.sourceReason})`
              : '';
        return res
          ? `Extract done${from}: ${res.cells} cells x ${res.frames.toLocaleString()} frames in ${res.seconds.toFixed(1)} s (${(res.frames / res.seconds).toFixed(0)} frames/s)`
          : 'Extract done';
      }
      case 'error':
        return `Extract stopped: ${p().error() ?? 'error'}`;
      case 'cancelled':
        return 'Extract cancelled';
      default:
        if (!extracts()) {
          if (pass1Busy()) return 'Live: the traces are solved as the frames come in';
          const r = liveResult();
          return r
            ? `Live run ended: ${r.cells} cells x ${r.frames.toLocaleString()} frames of live traces to export`
            : 'Live run ended';
        }
        return pass1Busy()
          ? auto()
            ? 'Extract starts when Discover finishes'
            : 'Extract runs after Discover finishes'
          : (props.availability.extract ?? 'Ready to Extract');
    }
  };
  const pass2Shown = () => p().status() === 'running' || p().status() === 'done';

  /** `withRecord`: gather the run record (at write time only; the cell count in the button reads this reactively without it). */
  /**
   * A `?factors` stream: Extract's traces are the export's, with the live traces beside them
   * (when they are for the same cells), the notes, and the frames both cover.
   */
  const factorExport = (
    r: Pass2Result,
  ): Pick<ExportInput, 'liveTraces' | 'notes' | 'frameRange'> | null => {
    if (!props.live) {
      // A recording's factor run (GPU or `?factors=file`): notes on what the settle and Extract read.
      const notes = fileFactorNotes(props.stages.runs());
      return notes.length ? { notes } : null;
    }
    if (r.source !== 'factors') return null;
    const live = liveResult();
    const same =
      live !== null &&
      live.ids.length === r.ids.length &&
      live.ids.every((id, i) => id === r.ids[i]);
    if (live && !same)
      console.warn('cala export: the live traces are for other cells than Extract; left out.');
    const tail = live !== null && r.frames < live.frames;
    return {
      ...(live && same ? { liveTraces: live.traces } : {}),
      notes: [FACTORS_EXPORT_NOTE, ...(tail ? [factorTailNote(r.frames, live.frames)] : [])],
      ...(tail ? { frameRange: { start: 0, end: r.frames } } : {}),
    };
  };
  const exportInput = (withRecord = false): ExportInput | null => {
    const r = exportResult();
    if (!r) return null;
    return {
      ...factorExport(r),
      label: props.label,
      width: props.width,
      height: props.height,
      fps: props.fps,
      result: r,
      run: s().record().snapshot(),
      flatField: s().record().flatFieldApplied,
      flatFieldMap: s().flatFieldMap(),
      ...(props.bitDepth ? { bitDepth: props.bitDepth } : {}),
      stages: props.stages.runs(),
      qc: c().qc(),
      firstSeen: c().firstSeen,
      history: {
        bins: props.ui.run.history().toExport(),
        eventsJson: props.ui.run.events().toJSON(),
      },
      ...(withRecord && props.runRecord
        ? {
            runRecord: props.runRecord({
              extractAfterDiscover: auto(),
              passQcOnly: passOnly(),
            }),
          }
        : {}),
      version: import.meta.env.VITE_APP_VERSION || 'dev',
    };
  };
  const keptForCaDecon = () => {
    const input = exportInput();
    return input ? cadeconCells(input, passOnly()).length : 0;
  };

  // ---- convergence over the shared time window ----
  const h = () => props.ui.run;
  const win = () => props.ui.window;
  const presets = () => windowPresets(props.ui.axisEnd());
  const windowValue = () => {
    const st = win().state;
    if (st.mode === 'last') return `last-${st.lastS}`;
    return st.mode;
  };
  const windowOptions = () => [
    { value: 'run', label: 'Run', title: 'The whole run (a file: to its end; live: to now)' },
    ...presets().map((p) => ({
      value: `last-${p.s}`,
      label: p.label,
      title: `The last ${p.label}, following now`,
    })),
    ...(win().state.mode === 'brush'
      ? [{ value: 'brush', label: 'Brush', title: 'A range brushed on the strip or a plot' }]
      : []),
  ];
  const setWindow = (v: string) => {
    if (v === 'run') win().setRun();
    else if (v.startsWith('last-')) win().setLast(Number(v.slice(5)));
  };
  const inspectedText = () => {
    const t = win().inspected();
    if (t === null) return null;
    const clock = h().clockAt(t);
    const span = props.ui.span();
    return `${formatElapsed(t, span.t1 - span.t0)}${clock !== null ? ` · ${formatClock(clock)}` : ''} · frame ${Math.round(t * h().fps()).toLocaleString()}`;
  };

  /** The three main steps (Discover, Final settle, Extract), as the run rail shows them. */
  const steps3 = createSteps(() => ({
    pipeline: s(),
    cells: c(),
    pass2: p(),
    live: props.live,
    sessionRun: props.sessionMode != null,
  }));

  const shown = () => props.visible !== false;

  return (
    <SidePanel
      id="run"
      title="Run"
      class="cala-run"
      actions={
        <>
          <button
            type="button"
            class="btn-secondary btn-small cala-icon-btn"
            disabled={!pass1Busy()}
            aria-label={s().status() === 'paused' ? 'Resume' : 'Pause'}
            title={s().status() === 'paused' ? 'Resume' : 'Pause'}
            onClick={() => s().togglePause()}
          >
            <Icon name={s().status() === 'paused' ? 'play' : 'pause'} size={14} />
          </button>
          <button
            type="button"
            class="btn-secondary btn-small cala-icon-btn"
            aria-label="Restart"
            title="Start Discover again from frame 0 (a new run: Extract starts over)"
            onClick={() => void s().start()}
          >
            <Icon name="restart" size={14} />
          </button>
          <Show when={pass1Busy()}>
            <button
              type="button"
              class="btn-secondary btn-small cala-icon-btn"
              data-testid="pass2-finish"
              aria-label={props.live ? 'Stop the live run' : 'End Discover'}
              title={
                props.live
                  ? 'Stop the live run: the cells found so far become the final library.'
                  : 'End Discover here: the cells found so far become the final library; Extract then runs over the frames read.'
              }
              onClick={() => void s().finishEarly()}
            >
              <Icon name="stop" size={14} />
            </button>
          </Show>
        </>
      }
    >
      {/* ---- 1. Settings: chosen before a run ---- */}
      <section class="cala-run__section" aria-labelledby="run-settings" data-testid="run-settings">
        <h3 id="run-settings" class="cala-run__heading">
          Settings
        </h3>
        <Show when={!props.live}>
          <div class="cala-run__footer">
            <DiscoverSettings pipeline={s()} context={settingsContext()} />
            <label
              class="cala-check"
              classList={{ 'cala-check--off': inSessionRun() }}
              title={
                inSessionRun()
                  ? 'A session run always Extracts each session once its Discover is done.'
                  : 'On by default: Extract starts as soon as Discover has its final cell set.'
              }
            >
              <input
                type="checkbox"
                disabled={inSessionRun()}
                checked={auto() || inSessionRun()}
                onChange={(e) => setAuto(e.currentTarget.checked)}
              />
              Extract after Discover
            </label>
          </div>
        </Show>
        <Show when={!props.live && (s().lookback() || s().lookbackRun())}>
          <p class="cala-muted cala-run__line" data-testid="lookback-note">
            <Show
              when={s().lookbackBlocked()}
              fallback={
                s().lookbackRun()
                  ? (s().plan()?.boundaries.length ?? 0) > 0
                    ? 'Look-back refines footprints during Discover, within the session it is reading, and runs a Final settle over every session after its last frame.'
                    : 'Look-back refines footprints during Discover and runs a Final settle after its last frame.'
                  : 'Look-back starts with the next Discover run (restart with ↻).'
              }
            >
              {(why) => `Look-back off: ${why()} Footprints get no refinement after Discover.`}
            </Show>
          </p>
        </Show>
        <details class="cala-run__more" data-testid="run-more-settings">
          <summary>More settings</summary>
          <label
            class="cala-check"
            title="On by default. Off: Discover keeps tracking the cells it already has but finds no new ones. Applies at once."
          >
            <input
              type="checkbox"
              disabled={replayBusy()}
              checked={s().discover()}
              onChange={(e) => s().setDiscover(e.currentTarget.checked)}
            />
            Find new cells
          </label>
        </details>
      </section>

      {/* ---- 2. Progress: the stage now, its speed and the workers ---- */}
      <section class="cala-run__section" aria-labelledby="run-progress" data-testid="run-progress">
        <h3 id="run-progress" class="cala-run__heading">
          Progress
        </h3>
        <StepPanel step={stepOf(steps3(), 'discover')}>
          <div class="cala-run__status">
            <span class="cala-status" data-testid="pipeline-status">
              {statusText()}
            </span>

            <Show when={backend()}>
              {(b) => (
                <span
                  class="cala-backend-badge"
                  classList={{ 'cala-backend-badge--warning': b().key === 'wasm-failed' }}
                  data-testid="motion-backend"
                  data-backend={b().key}
                  title={b().title}
                >
                  <Show when={b().key === 'webgpu'}>
                    <Icon name="gpu" size={12} />
                  </Show>
                  <Show when={b().key === 'wasm-failed'}>
                    <Icon name="warning" size={12} />
                  </Show>
                  {b().text}
                </span>
              )}
            </Show>
            <Show when={inspectedText()}>
              {(text) => (
                <button
                  type="button"
                  class="cala-inspected"
                  data-testid="inspected-time"
                  title="The inspected time (click a plot to pin one; Esc or this button returns to now)"
                  onClick={() => win().clearInspected()}
                >
                  ◉ {text()} ✕
                </button>
              )}
            </Show>
          </div>
          {/* `?debug`: who is doing what, once a second, as plain text (the Work display shows it as a grid). */}
          <Show when={DEBUG}>
            <pre class="cala-readout cala-run__line" data-testid="work-debug">
              {workText(
                s().work(),
                s().workFastMaxFps(),
                c().status()?.lookback?.csettle?.governor,
              )}
              {'\n'}
              {s().floorLine() || 'floor: waiting for a status'}
            </pre>
          </Show>
          <Show when={s().live()}>
            {(live) => (
              <p class="cala-readout cala-run__line" data-testid="live-readout">
                live: {live().received.toLocaleString()} received
                <Show when={live().dropped + live().missed > 0}>
                  {' '}
                  &middot; {live().dropped.toLocaleString()} dropped
                  <Show when={live().missed > 0}>
                    {' '}
                    ({live().missed.toLocaleString()} missed at the source)
                  </Show>
                </Show>{' '}
                &middot; lag {live().lagFrames} frames ({live().lagMs.toFixed(0)} ms)
              </p>
            )}
          </Show>
          <div class="cala-run__timeline">
            <div class="cala-run__window">
              <SegmentedControl
                options={windowOptions()}
                value={windowValue()}
                onChange={setWindow}
                aria-label="Time window"
                size="sm"
                testid="time-window"
              />
            </div>
            <Show when={shown()}>
              <RunStrip ui={props.ui} />
            </Show>
            {/* Expanded, the large History view has the convergence plot; the FOV gets the room. */}
            <Show when={!props.ui.expanded() && shown()}>
              <AspectPlot>
                {(h) => <GroupPlot ui={props.ui} group="convergence" height={h()} compact />}
              </AspectPlot>
            </Show>
          </div>
        </StepPanel>
        <StepPanel step={stepOf(steps3(), 'settle')}>
          <SettleBody pipeline={s()} cells={c()} step={stepOf(steps3(), 'settle')}>
            <Show
              when={s().lookbackRun() || extractsOnFactors() ? c().status()?.lookback : undefined}
            >
              {(lb) => (
                <div class="cala-run__footer">
                  <span class="cala-readout cala-wrap" data-testid="lookback-readout">
                    {lookbackText(lb(), c().status()?.final ?? false)}
                  </span>
                  <Show when={lb().settling && props.onStopSettling}>
                    <button
                      type="button"
                      class="btn-secondary btn-small"
                      data-testid="lookback-stop-settling"
                      title="Stop the Final settle now: the footprints refined so far become the final library."
                      onClick={() => props.onStopSettling?.()}
                    >
                      Stop Final settle
                    </button>
                  </Show>
                </div>
              )}
            </Show>
          </SettleBody>
        </StepPanel>
        <Show
          when={extracts()}
          fallback={
            <div class="cala-run__footer">
              <span
                class="cala-status cala-run__pass2"
                data-testid="pass2-status"
                data-state={p().status()}
              >
                {pass2Text()}
              </span>
            </div>
          }
        >
          <StepPanel step={stepOf(steps3(), 'extract')}>
            <ExtractBody pipeline={s()} pass2={p()} cells={c()}>
              <div class="cala-run__footer">
                <span
                  class="cala-status cala-run__pass2"
                  data-testid="pass2-status"
                  data-state={p().status()}
                >
                  {pass2Text()}
                </span>
                <Show when={pass2Shown()}>
                  <span class="cala-readout" data-testid="pass2-readout">
                    frame {p().processed().toLocaleString()} / {p().total().toLocaleString()}
                    <Show when={p().status() === 'running' && p().fps() > 0}>
                      {' '}
                      &middot; {p().fps().toFixed(1)} frames/s
                    </Show>
                    <Show when={p().motionBackend() === 'webgpu'}> &middot; warp: WebGPU</Show>
                  </span>
                </Show>
              </div>
            </ExtractBody>
          </StepPanel>
        </Show>
        <SpeedControl pipeline={s()} cells={c()} live={props.live} fps={props.fps} />
        <WorkDisplay pipeline={s()} cells={c()} ui={props.ui} live={props.live} visible={shown()} />
        <div class="cala-run__footer">
          <Show when={props.compress}>
            {(compress) => (
              <span class="cala-readout cala-wrap" data-testid="compress-readout">
                {compress().error() ?? compressReadout(compress().status(), compress().backfill())}
              </span>
            )}
          </Show>
          <Show when={props.review}>
            {(review) => (
              <span
                class="cala-readout cala-wrap"
                data-testid="review-readout"
                title="History review: cells the slow loop missed, looked for in the compressed history."
              >
                {review().error() ??
                  reviewReadout(
                    review().status(),
                    c().status()?.counters.reviewAdds ?? 0,
                    review().every,
                  )}
              </span>
            )}
          </Show>
        </div>
        <Show when={c().status()?.reservoirWarning}>
          {(w) => (
            <p class="cala-warning" role="status" data-testid="statusbar-warning">
              {w()}
            </p>
          )}
        </Show>
        <Show when={s().error()}>
          {(message) => (
            <div class="error-card" role="alert">
              <span>{message()}</span>
            </div>
          )}
        </Show>
        <Show when={c().error()}>
          {(message) => (
            <div class="error-card" role="alert">
              <span>Cell discovery stopped: {message()}</span>
            </div>
          )}
        </Show>
      </section>

      {/* ---- 3. Results: Extract and export ---- */}
      <section class="cala-run__section" aria-labelledby="run-results" data-testid="run-results">
        <h3 id="run-results" class="cala-run__heading">
          Results
        </h3>
        <Show when={props.live}>
          <p class="cala-muted cala-run__line" data-testid="live-stage-note">
            {props.factorRun ? FACTORS_LIVE_NOTE : LIVE_NOTE}
          </p>
        </Show>
        <Show when={!props.live}>
          <Show
            when={showNextStepHint({
              live: props.live === true,
              discover: s().status() === 'done' ? 'done' : 'running',
              extract: p().status(),
            })}
          >
            <p class="cala-muted cala-run__line" data-testid="next-step-hint">
              {NEXT_STEP_HINT}
            </p>
          </Show>
        </Show>
        <div class="cala-run__footer">
          <Show
            when={p().status() !== 'running' && extracts()}
            fallback={
              <Show when={extracts()}>
                <button type="button" class="btn-secondary btn-small" onClick={() => p().cancel()}>
                  Cancel Extract
                </button>
              </Show>
            }
          >
            <button
              type="button"
              class="btn-secondary btn-small"
              data-testid="pass2-run"
              disabled={p().blockedReason() !== null}
              title={
                p().blockedReason() ??
                'Extract: solve the traces of every frame with the final footprints, frozen.'
              }
              onClick={() => void p().run()}
            >
              {p().status() === 'done' ? 'Extract again' : 'Extract'}
            </button>
          </Show>
          <details class="cala-menu" data-testid="export-menu">
            <summary class="btn-secondary btn-small" aria-disabled={!exportResult()}>
              Export &#9662;
            </summary>
            <div class="cala-menu__body">
              <button
                type="button"
                class="btn-secondary btn-small"
                data-testid="export-npz"
                disabled={!exportResult() || exporting() !== null}
                title={
                  props.live
                    ? 'Footprints, the live traces, motion, flicker and cell metadata (NumPy .npz).'
                    : "Footprints, Extract's traces, motion, flicker, the stages run and cell metadata (NumPy .npz)."
                }
                onClick={() => {
                  const input = exportInput(true);
                  if (input)
                    void runExport(
                      `${fileStem(props.label)}_cala.npz`,
                      calaExportBytes(input),
                      (sink, prog) => writeCalaExport(input, sink, { onProgress: prog }),
                      exportFormatVersion(input),
                    );
                }}
              >
                Export (.npz)
              </button>
              <button
                type="button"
                class="btn-secondary btn-small"
                data-testid="export-cadecon"
                disabled={!exportResult() || exporting() !== null}
                title={`Traces for CaDecon (open the file there, sampling rate ${props.fps > 0 ? `${props.fps} Hz` : 'of your recording'}).`}
                onClick={() => {
                  const input = exportInput(true);
                  if (input)
                    void runExport(
                      `${fileStem(props.label)}_cala_cadecon.npz`,
                      input.result.frames * cadeconCells(input, passOnly()).length * 4,
                      (sink, prog) =>
                        writeCaDeconExport(input, sink, passOnly(), { onProgress: prog }),
                    );
                }}
              >
                Export for CaDecon{exportResult() ? ` (${keptForCaDecon()} cells)` : ''}
              </button>
              <label class="cala-check">
                <input
                  type="checkbox"
                  checked={passOnly()}
                  onChange={(e) => setPassOnly(e.currentTarget.checked)}
                />
                QC-passing cells only (CaDecon)
              </label>
              <Show when={!exportResult()}>
                <span class="cala-muted">
                  {props.live
                    ? 'Available when the live run has ended.'
                    : 'Available when Extract is done.'}
                </span>
              </Show>
              <Show
                when={
                  exportResult() &&
                  !cadeconIsClassic(
                    exportResult()!.frames,
                    cadeconCells(exportInput()!, passOnly()).length,
                  )
                }
              >
                <span class="cala-readout cala-wrap" data-testid="cadecon-large-note">
                  Too large for CaDecon to open (over 512 MB of traces): use the .npz with np.load,
                  or export fewer cells.
                </span>
              </Show>
            </div>
          </details>
          <Show when={exporting()}>
            <span class="cala-readout" data-testid="export-progress">
              {exporting()}
            </span>
          </Show>
          <Show when={exportError()}>
            <span class="cala-status" data-testid="export-error" data-state="error">
              Export failed: {exportError()}
            </span>
          </Show>
        </div>
      </section>
    </SidePanel>
  );
}
