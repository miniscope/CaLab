import { createEffect, createSignal, For, on, Show, type JSX } from 'solid-js';
import { MetricTile, ProgressBar, SegmentedControl } from '@calab/ui';
import { formatClock, formatElapsed, windowPresets } from '@calab/ui/chart';
import type { ByteSink } from '@calab/io';
import type { CellStore } from '../lib/cell-store.ts';
import { compressReadout, type CompressStore } from '../lib/compress-store.ts';
import { reviewReadout, type ReviewStore } from '../lib/review-store.ts';
import type { PipelineStore } from '../lib/pipeline-store.ts';
import type { Pass2Result, Pass2Store } from '../lib/pass2-store.ts';
import type { ConvergenceState } from '../lib/qc.ts';
import { groupKeys } from '../lib/run-history.ts';
import { GroupPlot, RunStrip, type HistoryUi } from './HistoryPanel.tsx';
import { liveTraceResult } from '../lib/live-export.ts';
import {
  cadeconCells,
  cadeconIsClassic,
  calaExportBytes,
  fileStem,
  saveExport,
  writeCaDeconExport,
  writeCalaExport,
  type ExportInput,
} from '../lib/export.ts';
import { SidePanel } from './SidePanel.tsx';

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
  single: ['Motion: CPU', 'Single-worker pipeline (?pipeline=0) runs motion in WASM.'],
} as const;

const STATE_LABEL: Record<ConvergenceState, string> = {
  waiting: 'Waiting for cells',
  discovering: 'Discovering cells',
  settling: 'Settling',
  converged: 'Converged',
};

type StepState = 'done' | 'active' | 'pending';

/** Narrow windows: the passes as a horizontal stepper. */
function PassStepper(props: {
  steps: { label: string; sub: string; state: StepState }[];
}): JSX.Element {
  return (
    <ol class="cala-stepper" data-testid="pass-stepper">
      <For each={props.steps}>
        {(s, i) => (
          <li class={`cala-stepper__step cala-stepper__step--${s.state}`}>
            <span class="cala-stepper__dot">{s.state === 'done' ? '✓' : i() + 1}</span>
            <span class="cala-stepper__text">
              <span class="cala-stepper__label">{s.label}</span>
              <span class="cala-stepper__sub">{s.sub}</span>
            </span>
          </li>
        )}
      </For>
    </ol>
  );
}

export interface RunPanelProps {
  pipeline: PipelineStore;
  pass2: Pass2Store;
  cells: CellStore;
  /** A live source: no file to re-read, so pass 2 cannot run; the stop button ends the stream and the export takes the live traces. */
  live?: boolean;
  /** Recording label (the folder name). */
  label: string;
  width: number;
  height: number;
  /** Frame rate, Hz (0 when unknown). */
  fps: number;
  /** Narrow window: a stepper and metric tiles instead of the timeline. */
  narrow?: boolean;
  /** The run's history views (shared time window and cursor). */
  ui: HistoryUi;
  /** Present when the run compresses its frames (`?compress`). */
  compress?: CompressStore;
  /** Present when the run reviews its compressed history (`?compress&review`). */
  review?: ReviewStore;
}

/**
 * The run: pass 1 (discover) and pass 2 (re-extract) progress and the
 * convergence metrics on one time axis (minutes of the recording) with a
 * "now" line, the run controls, and the export. Pass 2 follows pass 1 on
 * its own unless turned off.
 */
export function RunPanel(props: RunPanelProps): JSX.Element {
  const s = () => props.pipeline;
  const c = () => props.cells;
  const p = () => props.pass2;

  // ---- pass 1 ----
  const total = () => s().plan()?.frameCount ?? 0;
  const unbounded = () => !Number.isFinite(total());
  const fraction = () => (total() > 0 && !unbounded() ? s().processed() / total() : 0);
  const statusText = () => {
    const st = s().status();
    if (st === 'starting') return 'Starting';
    if (st === 'error') return 'Stopped by an error';
    if (st === 'done') return 'Done';
    const setup = s().setup();
    const prefix = st === 'paused' ? 'Paused: ' : '';
    if (s().processed() === 0 && setup) {
      return `${prefix}${SETUP_LABEL[setup.phase]} ${setup.done} / ${setup.total}`;
    }
    return st === 'paused' ? 'Paused' : 'Running';
  };
  const backend = () => {
    if (s().fps() <= 0) return null;
    const b = s().motionBackend() ?? 'single';
    return { key: b, text: MOTION_BACKEND[b][0], title: MOTION_BACKEND[b][1] };
  };
  const pass1Busy = () => s().status() === 'running' || s().status() === 'paused';
  const lagNow = () => {
    c().tick();
    const v = c().metrics().lag.at(-1);
    return v === null || v === undefined ? null : v;
  };
  const pass1State = () => {
    const st = s().status();
    if (st === 'done') return 'complete' as const;
    if (st === 'paused') return 'paused' as const;
    if (st === 'error') return 'error' as const;
    return st === 'running' ? ('running' as const) : ('idle' as const);
  };

  // ---- pass 2 and export ----
  const [auto, setAuto] = createSignal(true);
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
      setExportError(err instanceof Error ? err.message : String(err)),
    );
  });
  const exportResult = () => p().result() ?? liveResult();

  /** Stream one export to disk (see `saveExport`), with progress and errors in the panel. */
  async function runExport(
    name: string,
    sizeHint: number,
    write: (sink: ByteSink, progress: (done: number, total: number) => void) => Promise<void>,
  ): Promise<void> {
    setExportError(null);
    setExporting(`Exporting ${name}`);
    try {
      await saveExport(name, sizeHint, (sink) =>
        write(sink, (done, all) =>
          setExporting(`Exporting ${name}: ${all > 0 ? Math.floor((100 * done) / all) : 0}%`),
        ),
      );
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(null);
    }
  }

  // A new pass 1 invalidates pass 2's result.
  createEffect(
    on(
      () => s().status(),
      (st) => {
        if (st === 'starting') p().clear();
      },
    ),
  );
  // Pass 2 follows pass 1 once the final library is out.
  createEffect(() => {
    if (
      auto() &&
      !props.live &&
      s().status() === 'done' &&
      p().status() === 'idle' &&
      p().blockedReason() === null
    )
      void p().run();
  });

  const pass2Text = () => {
    switch (p().status()) {
      case 'running':
        return 'Pass 2: re-extracting traces with the final library';
      case 'done': {
        const r = p().result();
        return r
          ? `Pass 2 done: ${r.cells} cells x ${r.frames.toLocaleString()} frames in ${r.seconds.toFixed(1)} s (${(r.frames / r.seconds).toFixed(0)} frames/s)`
          : 'Pass 2 done';
      }
      case 'error':
        return `Pass 2 stopped: ${p().error() ?? 'error'}`;
      case 'cancelled':
        return 'Pass 2 cancelled';
      default:
        if (props.live) {
          if (pass1Busy()) return 'Live: the traces are solved as the frames come in';
          const r = liveResult();
          return r
            ? `Live run ended: ${r.cells} cells x ${r.frames.toLocaleString()} frames of live traces to export`
            : 'Live run ended';
        }
        return pass1Busy()
          ? 'Pass 2 starts when pass 1 finishes'
          : (p().blockedReason() ?? 'Ready for pass 2');
    }
  };
  const pass2Shown = () => p().status() === 'running' || p().status() === 'done';
  const pass2Fraction = () => {
    // On the recording's axis: pass 2 re-reads the frames pass 1 read.
    const all = Number.isFinite(total()) && total() > 0 ? total() : p().total();
    return all > 0 ? p().processed() / all : 0;
  };
  const pass2State = () => {
    switch (p().status()) {
      case 'running':
        return 'running' as const;
      case 'done':
        return 'complete' as const;
      case 'error':
        return 'error' as const;
      default:
        return 'idle' as const;
    }
  };
  const pass2Value = () => {
    switch (p().status()) {
      case 'running':
        return `${Math.round(100 * (p().total() > 0 ? p().processed() / p().total() : 0))}%`;
      case 'done':
        return 'done';
      case 'error':
        return 'error';
      case 'cancelled':
        return 'cancelled';
      default:
        return auto() ? 'queued' : 'manual';
    }
  };

  const exportInput = (): ExportInput | null => {
    const r = exportResult();
    if (!r) return null;
    return {
      label: props.label,
      width: props.width,
      height: props.height,
      fps: props.fps,
      result: r,
      run: s().record().snapshot(),
      flatField: s().record().flatFieldApplied,
      qc: c().qc(),
      firstSeen: c().firstSeen,
      version: import.meta.env.VITE_APP_VERSION || 'dev',
    };
  };
  const keptForCaDecon = () => {
    const input = exportInput();
    return input ? cadeconCells(input, passOnly()).length : 0;
  };

  // ---- convergence over the shared time window ----
  const conv = () => c().convergence();
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
  /** Narrow tiles: each convergence series over the window, on its fixed range. */
  const tiles = () => {
    h().tick();
    const store = h().history();
    const { t0, t1 } = props.ui.span();
    return groupKeys('convergence', false).map((key) => {
      const spec = store.spec(key)!;
      const v = store.view(key, t0, t1, 60);
      const x: number[] = [];
      const y: number[] = [];
      if (v)
        for (let i = 0; i < v.n; i++) {
          x.push(v.t0 + (i + 0.5) * v.binS - t0);
          y.push(v.mean[i]);
        }
      const r = store.displayRange(key);
      const latest = store.latest(key);
      return {
        key,
        title: spec.short ?? spec.label,
        value: Number.isFinite(latest) ? latest.toFixed(spec.digits) : 'n/a',
        hint: `${spec.label}: ${spec.hint ?? ''} Range ${r.lo}–${r.hi} ${spec.unit}`.trim(),
        x,
        x1: t1 - t0,
        lines: [{ values: y, color: spec.color }],
        range: [r.lo, r.hi] as [number, number],
      };
    });
  };

  const steps = (): { label: string; sub: string; state: StepState }[] => {
    const st = s().status();
    const setup = s().setup();
    const calibrating = s().processed() === 0 && setup !== null && pass1Busy();
    const p2 = p().status();
    return [
      {
        label: 'Calibrate',
        sub: calibrating && setup ? `${setup.done} / ${setup.total}` : '',
        state: calibrating ? 'active' : s().processed() > 0 || st === 'done' ? 'done' : 'pending',
      },
      {
        label: 'Pass 1',
        sub: props.live ? 'discover (live)' : `discover ${Math.round(100 * fraction())}%`,
        state: st === 'done' ? 'done' : !calibrating && pass1Busy() ? 'active' : 'pending',
      },
      {
        label: 'Pass 2',
        sub: props.live ? 'not for live' : `re-extract ${pass2Value()}`,
        state: p2 === 'done' ? 'done' : p2 === 'running' ? 'active' : 'pending',
      },
      {
        label: 'Export',
        sub: exportResult() ? 'ready' : '',
        state: exportResult() ? 'active' : 'pending',
      },
    ];
  };

  const [metricsOpen, setMetricsOpen] = createSignal(true);

  return (
    <SidePanel
      id="run"
      title="Run"
      class="cala-run"
      open={metricsOpen()}
      onToggle={setMetricsOpen}
      toggleLabel={(open) => (open ? 'Hide the convergence plot' : 'Show the convergence plot')}
      head={
        <div class="cala-run__conv" data-testid="convergence-status" title={conv().reason}>
          <span class={`cala-conv-chip cala-conv-chip--${conv().state}`}>
            {STATE_LABEL[conv().state]}
          </span>
          <span class="cala-visually-hidden">{conv().reason}</span>
        </div>
      }
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
            {s().status() === 'paused' ? '▶' : '⏸'}
          </button>
          <button
            type="button"
            class="btn-secondary btn-small cala-icon-btn"
            aria-label="Restart"
            title="Restart pass 1 from frame 0 (a new run)"
            onClick={() => void s().start()}
          >
            ↻
          </button>
          <Show when={pass1Busy()}>
            <button
              type="button"
              class="btn-secondary btn-small cala-icon-btn"
              data-testid="pass2-finish"
              aria-label={props.live ? 'Stop the live run' : 'End pass 1'}
              title={
                props.live
                  ? 'Stop the live run: the cells found so far become the final library.'
                  : 'End pass 1 here: the cells found so far become the final library, then pass 2 runs over the frames read.'
              }
              onClick={() => void s().finishEarly()}
            >
              ■
            </button>
          </Show>
        </>
      }
      // The pass rows stay when the metric rows are folded away.
      alwaysShown
    >
      <div class="cala-run__status">
        <span class="cala-status" data-testid="pipeline-status">
          {statusText()}
        </span>
        <span class="cala-readout" data-testid="pipeline-readout">
          <Show when={!unbounded() && total() > 0} fallback={props.live ? 'live · ' : ''}>
            {Math.floor(100 * fraction())}% &middot;{' '}
          </Show>
          frame {s().processed().toLocaleString()}
          <Show when={!unbounded()}> / {total().toLocaleString()}</Show>
          <Show when={s().fps() > 0}> &middot; {s().fps().toFixed(1)} fps</Show>
        </span>
        <Show when={backend()}>
          {(b) => (
            <span
              class="cala-backend-badge"
              classList={{ 'cala-backend-badge--gpu': b().key === 'webgpu' }}
              data-testid="motion-backend"
              data-backend={b().key}
              title={b().title}
            >
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

      <Show
        when={!props.narrow}
        fallback={
          <>
            <PassStepper steps={steps()} />
            <Show when={!unbounded()}>
              <ProgressBar
                fraction={fraction()}
                state={pass1State()}
                label="Pass 1: discover"
                aria-label="Pass 1"
              />
            </Show>
            <Show when={pass2Shown()}>
              <ProgressBar
                fraction={p().total() > 0 ? p().processed() / p().total() : 0}
                state={pass2State()}
                label="Pass 2: re-extract"
                aria-label="Pass 2"
              />
            </Show>
            <Show when={metricsOpen()}>
              <div class="cala-run__tiles">
                <For each={tiles()}>
                  {(m) => (
                    <MetricTile
                      title={m.title}
                      value={m.value}
                      hint={m.hint}
                      x={m.x}
                      xMax={m.x1}
                      lines={m.lines}
                      range={m.range}
                      testid={`tile-${m.key}`}
                    />
                  )}
                </For>
              </div>
            </Show>
          </>
        }
      >
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
          <RunStrip ui={props.ui} />
          {/* Expanded, the large History view has the convergence plot; the FOV gets the room. */}
          <Show when={metricsOpen() && !props.ui.expanded()}>
            <GroupPlot ui={props.ui} group="convergence" height={130} compact />
          </Show>
          <Show when={!props.live && pass2Shown()}>
            <ProgressBar
              fraction={pass2Fraction()}
              state={pass2State()}
              label="Pass 2"
              aria-label="Pass 2"
            />
          </Show>
        </div>
      </Show>

      <div class="cala-run__footer">
        <span class="cala-readout" data-testid="cells-readout">
          {c().library()?.ids.length ?? 0} cells &middot; library v{c().version()} &middot; lag{' '}
          {lagNow() ?? 'n/a'} frames
        </span>
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
        <label class="cala-check" title="Run cell discovery on the frames as they are read.">
          <input
            type="checkbox"
            checked={s().discover()}
            onChange={(e) => s().setDiscover(e.currentTarget.checked)}
          />
          Discover cells
        </label>
        <Show when={!props.live}>
          <label class="cala-check" title="Start pass 2 as soon as pass 1 has its final library.">
            <input
              type="checkbox"
              checked={auto()}
              onChange={(e) => setAuto(e.currentTarget.checked)}
            />
            Pass 2 after pass 1
          </label>
        </Show>
      </div>
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
      <div class="cala-run__footer">
        <Show
          when={p().status() !== 'running' && !props.live}
          fallback={
            <Show when={!props.live}>
              <button type="button" class="btn-secondary btn-small" onClick={() => p().cancel()}>
                Cancel pass 2
              </button>
            </Show>
          }
        >
          <button
            type="button"
            class="btn-secondary btn-small"
            data-testid="pass2-run"
            disabled={p().blockedReason() !== null}
            title={p().blockedReason() ?? 'Re-extract every frame with the final library.'}
            onClick={() => void p().run()}
          >
            Run pass 2
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
                  : 'Footprints, pass-2 traces, motion, flicker and cell metadata (NumPy .npz).'
              }
              onClick={() => {
                const input = exportInput();
                if (input)
                  void runExport(
                    `${fileStem(props.label)}_cala.npz`,
                    calaExportBytes(input),
                    (sink, prog) => writeCalaExport(input, sink, { onProgress: prog }),
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
                const input = exportInput();
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
                  : 'Available when pass 2 is done.'}
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
                Too large for CaDecon to open (over 512 MB of traces): use the .npz with np.load, or
                export fewer cells.
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
    </SidePanel>
  );
}
