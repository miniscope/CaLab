import { createEffect, createSignal, on, Show, type JSX } from 'solid-js';
import { Icon, SegmentedControl } from '@calab/ui';
import { formatClock, formatElapsed, windowPresets } from '@calab/ui/chart';
import type { CellStore } from '../lib/cell-store.ts';
import { compressReadout, type CompressStore } from '../lib/compress-store.ts';
import { reviewReadout, type ReviewStore } from '../lib/review-store.ts';
import type { PipelineStore } from '../lib/pipeline-store.ts';
import { clearResultExported } from '../lib/export-state.ts';
import { settleNote } from '../lib/lookback-text.ts';
import type { LibraryMode } from '../lib/session-run.ts';
import { workText } from '../lib/work-meter.ts';
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
import { StepClock } from '../lib/step-view.ts';
import { AspectPlot } from '../lib/plot-size.tsx';
import { GroupPlot, RunStrip, type HistoryUi } from './HistoryPanel.tsx';
import { FACTORS_LIVE_NOTE } from '../lib/factor-run.ts';
import type { SettingsContext } from './DiscoverSettings.tsx';
import { PreRunSheet, SettingsSummary } from './RunSettings.tsx';
import { SidePanel } from './SidePanel.tsx';
import { SpeedControl } from './SpeedControl.tsx';
import { WorkDisplay } from './WorkDisplay.tsx';
import {
  createLookbackFacts,
  createSteps,
  DiscoverBody,
  ExtractBody,
  SettleBody,
  StepBlock,
  stepOf,
} from './Steps.tsx';

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

const n0 = (v: number): string => Math.round(v).toLocaleString('en-US');

export interface RunPanelProps {
  pipeline: PipelineStore;
  /** The Extract stage (its store keeps the older name). */
  pass2: Pass2Store;
  /** The runs of the stages since Discover started. */
  stages: StageLog;
  /** Why each stage cannot start now (null: it can). */
  availability: Record<StageName, string | null>;
  cells: CellStore;
  /** A live source: Discover only (no file to replay); the stop button ends the stream. */
  live?: boolean;
  /** A live run's traces once it has ended (`createLiveResult`; null for a recording). */
  liveResult?: () => Pass2Result | null;
  /** Frame rate, Hz (0 when unknown). */
  fps: number;
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
 * The run (docs/stages.md). Before the first run of a recording: the pre-run sheet (settings,
 * Speed, Run). Then: a summary line of the settings, the step list (the running step as a
 * panel with its meter rows, every other step as one line), the convergence over the shared
 * time window, Speed and Workers, and Extract. Extract follows Discover only if "Extract after
 * Discover" is on (the default). The export is on the run rail (`ExportMenu`).
 */
export function RunPanel(props: RunPanelProps): JSX.Element {
  const s = () => props.pipeline;
  const c = () => props.cells;
  const p = () => props.pass2;
  // ---- Discover ----
  const statusText = () => {
    const st = s().status();
    if (st === 'idle') return 'Ready';
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

  const inSessionRun = () => props.sessionMode != null;
  /** Before the first run of one recording: the pre-run sheet. A session run starts by itself. */
  const prerun = () => s().status() === 'idle' && !inSessionRun() && !props.live;
  /** When a change to a start-time setting takes effect (`DiscoverSettings`). */
  const settingsContext = (): SettingsContext =>
    props.sessionMode === 'separate' ? 'separate' : props.sessionMode ? 'joint' : 'single';

  // ---- Extract ----
  /** Extract runs in this run: a recording, or a stream whose factors it solves on. */
  const extracts = () => !props.live || props.factorRun === true;
  const auto = extractAfterDiscover;
  const liveResult = () => props.liveResult?.() ?? null;

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
  const step = (key: 'discover' | 'settle' | 'extract') => stepOf(steps3(), key);

  // Each step's wall time, noted on every change of a step's state.
  const clock = new StepClock();
  const [clockBeat, setClockBeat] = createSignal(0);
  createEffect(
    on(
      () =>
        steps3()
          .map((v) => v.state)
          .join('|'),
      () => {
        if (s().status() === 'starting') clock.reset();
        clock.note(steps3(), performance.now());
        setClockBeat((n) => n + 1);
      },
    ),
  );
  const seconds = (key: 'discover' | 'settle' | 'extract') => {
    clockBeat();
    return clock.seconds(key);
  };
  const lookback = createLookbackFacts(c, () =>
    steps3()
      .map((v) => v.state)
      .join('|'),
  );
  const settleFacts = (): string[] => {
    const st = lookback()?.settle;
    return st ? [`${n0(st.fed)} frames`] : [];
  };
  const extractFacts = (): string[] => {
    const r = p().result();
    return r ? [`${n0(r.cells)} cells × ${n0(r.frames)} frames`] : [];
  };
  const discoverFacts = (): string[] => [`${n0(c().library()?.ids.length ?? 0)} cells`];
  /** The Final settle's note (where it read, a stop, an error), on its panel and its line. */
  const lookbackNote = () => {
    const f = lookback();
    if (!f || !(s().lookbackRun() || props.factorRun === true)) return '';
    return settleNote(f);
  };

  const shown = () => props.visible !== false;

  return (
    <SidePanel
      id="run"
      title="Run"
      class="cala-run"
      actions={
        <Show when={!prerun()}>
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
            title="Start Discover again from frame 0 with the settings as they are now (a new run: Extract starts over)"
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
        </Show>
      }
    >
      {/* ---- 1. Settings: the pre-run sheet, then a summary line ---- */}
      <Show when={!props.live}>
        <Show
          when={prerun()}
          fallback={
            <SettingsSummary
              pipeline={s()}
              context={settingsContext()}
              autoExtract={auto()}
              onAutoExtract={setExtractAfterDiscover}
              sessionRun={inSessionRun()}
              extractRunning={p().status() === 'running'}
            />
          }
        >
          <PreRunSheet
            pipeline={s()}
            context="prerun"
            autoExtract={auto()}
            onAutoExtract={setExtractAfterDiscover}
            sessionRun={false}
            onRun={() => void s().start()}
          />
        </Show>
      </Show>

      {/* ---- 2. Progress: the steps, the convergence, speed and workers ---- */}
      <Show when={!prerun()}>
        <section
          class="cala-run__section"
          aria-labelledby="run-progress"
          data-testid="run-progress"
        >
          <h3 id="run-progress" class="cala-run__heading">
            Progress
          </h3>
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
          <div class="cala-run__steps">
            <StepBlock
              step={step('discover')}
              facts={discoverFacts()}
              seconds={seconds('discover')}
              body={<DiscoverBody pipeline={s()} cells={c()} step={step('discover')} />}
            />
            <StepBlock
              step={step('settle')}
              facts={settleFacts()}
              seconds={seconds('settle')}
              line={
                <Show when={lookbackNote()}>
                  <span class="cala-stepline__fact" data-testid="lookback-readout">
                    {lookbackNote()}
                  </span>
                </Show>
              }
              body={
                <SettleBody pipeline={s()} cells={c()} step={step('settle')}>
                  <div class="cala-run__footer">
                    <span class="cala-step__note cala-wrap" data-testid="lookback-readout">
                      {lookbackNote()}
                    </span>
                    <Show when={props.onStopSettling}>
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
                </SettleBody>
              }
            />
            <Show when={extracts()}>
              <StepBlock
                step={step('extract')}
                facts={extractFacts()}
                seconds={seconds('extract')}
                body={<ExtractBody pipeline={s()} pass2={p()} cells={c()} />}
              />
            </Show>
          </div>
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
        </section>
      </Show>
      <SpeedControl pipeline={s()} cells={c()} live={props.live} fps={props.fps} />
      <Show when={!prerun()}>
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

        {/* ---- 3. Results: Extract (the export is on the run rail) ---- */}
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
                  <button
                    type="button"
                    class="btn-secondary btn-small"
                    onClick={() => p().cancel()}
                  >
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
            <span
              class="cala-status cala-run__pass2"
              data-testid="pass2-status"
              data-state={p().status()}
            >
              {pass2Text()}
            </span>
          </div>
        </section>
      </Show>
    </SidePanel>
  );
}
