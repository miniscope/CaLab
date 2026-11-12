import { createEffect, createMemo, createSignal, For, on, Show, type JSX } from 'solid-js';
import { MetricTile, ProgressBar, sparkPath, sparkRange, type SparkLine } from '@calab/ui';
import { OKABE_ITO } from '@calab/ui/chart';
import type { ByteSink } from '@calab/io';
import type { CellStore } from '../lib/cell-store.ts';
import { compressReadout, type CompressStore } from '../lib/compress-store.ts';
import type { PipelineStore } from '../lib/pipeline-store.ts';
import type { Pass2Result, Pass2Store } from '../lib/pass2-store.ts';
import type { ConvergencePoint, ConvergenceState } from '../lib/qc.ts';
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

/** The three kinds of churn, each its own line. */
const CHURN = [
  { key: 'reAdds', label: 'r', name: 're-adds', color: OKABE_ITO.orange },
  { key: 'churned', label: 'c', name: 'adds removed again', color: OKABE_ITO.vermillion },
  {
    key: 'establishedRemovals',
    label: 'e',
    name: 'established cells merged or deleted',
    color: OKABE_ITO.blue,
  },
] as const;

const fmt = (v: number | undefined, digits = 2) =>
  v === undefined || !Number.isFinite(v) ? 'n/a' : v.toFixed(digits);

/** One convergence metric: a row of the timeline (wide) or a tile (narrow). */
interface Metric {
  title: string;
  value: JSX.Element;
  hint: string;
  lines: SparkLine[];
  range?: [number, number];
  testid: string;
}

const PLOT_W = 1000;
const PLOT_H = 18;

/** A metric row on the shared time axis: label, curve, current value. */
function MetricRow(props: { metric: Metric; x: number[]; x1: number }): JSX.Element {
  const box = createMemo(() => sparkRange(props.metric.lines, props.metric.range));
  return (
    <div class="cala-run__row" title={props.metric.hint} data-testid={props.metric.testid}>
      <span class="cala-run__label">{props.metric.title}</span>
      <svg
        class="cala-run__plot"
        viewBox={`0 0 ${PLOT_W} ${PLOT_H}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <For each={props.metric.lines}>
          {(l) => (
            <path
              d={sparkPath(props.x, l.values, props.x1, box().lo, box().hi, PLOT_W, PLOT_H)}
              fill="none"
              stroke={l.color}
              stroke-width="1.4"
              stroke-dasharray={l.dash}
              vector-effect="non-scaling-stroke"
            />
          )}
        </For>
      </svg>
      <span class="cala-run__value">{props.metric.value}</span>
    </div>
  );
}

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
  /** Present when the run compresses its frames (`?compress`). */
  compress?: CompressStore;
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

  // ---- convergence metrics on the shared axis ----
  const pts = createMemo(() => c().convergenceHistory().slice());
  const x = () => pts().map((q) => q.minutes);
  const col = (k: keyof Omit<ConvergencePoint, 'edits'>) => pts().map((q) => q[k]);
  const edit = (k: keyof ConvergencePoint['edits']) => pts().map((q) => q.edits[k]);
  const last = () => pts().at(-1);
  const conv = () => c().convergence();
  /** Minutes the axis spans: the recording, or (live) what has been read. */
  const axisMinutes = () => {
    const fps = props.fps > 0 ? props.fps : (c().fps() ?? 20);
    if (!unbounded() && total() > 0) return total() / fps / 60;
    return Math.max(last()?.minutes ?? 0, s().processed() / fps / 60, 1e-6);
  };
  /** Where the "now" line is, 0..1 of the axis. */
  const nowFraction = () => {
    if (p().status() === 'running') return pass2Fraction();
    if (unbounded()) return 1;
    return fraction();
  };

  const metrics = (): Metric[] => [
    {
      title: 'Cells',
      value: fmt(last()?.cells, 0),
      hint: 'Cells in the library the fast loop solves.',
      lines: [{ values: col('cells'), color: OKABE_ITO.blue }],
      testid: 'spark-cells',
    },
    {
      title: 'New / min',
      value: fmt(last()?.edits.newAdds, 1),
      hint: 'Discovery: cells added at a spot where nothing was just removed. It slows over a recording but never has to reach zero (long recordings keep revealing cells), so it does not hold up the status.',
      lines: [{ values: edit('newAdds'), color: OKABE_ITO.bluishGreen }],
      testid: 'spark-discovery',
    },
    {
      title: 'Churn / min',
      value: (
        <For each={CHURN}>
          {(k) => (
            <span style={{ color: k.color }} title={k.name}>
              {' '}
              {k.label}
              {fmt(last()?.edits[k.key], 0)}
            </span>
          )}
        </For>
      ),
      hint: 'Spurious edits per minute of recording: r = re-adds (a cell added where one was removed in the last 2 min, orange), c = adds merged or deleted again within 2 min (red), e = established cells merged or deleted (blue). Should die out; it feeds the status.',
      lines: CHURN.map((k) => ({ values: edit(k.key), color: k.color })),
      testid: 'spark-churn',
    },
    {
      title: 'Stable',
      value: fmt(last()?.stableFrac),
      hint: 'Share of cells older than 2 min whose footprint (cosine >= 0.95) and trace noise (within 10%) match 1-2 min ago; dashed: median footprint cosine. Should rise to a plateau; it feeds the status.',
      lines: [
        { values: col('stableFrac'), color: OKABE_ITO.reddishPurple },
        { values: col('fpStability'), color: OKABE_ITO.reddishPurple, dash: '3 2' },
      ],
      range: [0, 1],
      testid: 'spark-stability',
    },
    {
      title: 'Explained',
      value: fmt(last()?.explained),
      hint: 'Share of the signal variance (above noise) the model explains. Rises to an asymptote as cells are found (tracked true recall in validation).',
      lines: [{ values: col('explained'), color: OKABE_ITO.bluishGreen }],
      range: [0, 1],
      testid: 'spark-explained',
    },
    {
      title: 'Residual excess',
      value: fmt(last()?.residualExcess),
      hint: 'Residual variance above noise, averaged over the field of view. Falls to an asymptote as the model explains more.',
      lines: [{ values: col('residualExcess'), color: OKABE_ITO.vermillion }],
      testid: 'spark-residual',
    },
  ];

  const ticks = () => {
    const t = axisMinutes();
    return [0, 0.25, 0.5, 0.75, 1].map((f) => ({ f, label: (f * t).toFixed(t < 2 ? 1 : 0) }));
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
      toggleLabel={(open) => (open ? 'Hide the metric rows' : 'Show the metric rows')}
      head={
        <div class="cala-run__conv" data-testid="convergence-status" title={conv().reason}>
          <span class={`cala-conv-chip cala-conv-chip--${conv().state}`}>
            {STATE_LABEL[conv().state]}
          </span>
          <span class="cala-muted cala-run__reason">{conv().reason}</span>
        </div>
      }
      actions={
        <>
          <button
            type="button"
            class="btn-secondary btn-small"
            disabled={!pass1Busy()}
            onClick={() => s().togglePause()}
          >
            {s().status() === 'paused' ? 'Resume' : 'Pause'}
          </button>
          <button type="button" class="btn-secondary btn-small" onClick={() => void s().start()}>
            Restart
          </button>
          <Show when={pass1Busy()}>
            <button
              type="button"
              class="btn-secondary btn-small"
              data-testid="pass2-finish"
              title={
                props.live
                  ? 'End the live run here: the cells found so far become the final library.'
                  : 'Stop reading here: the cells found so far become the final library, then pass 2 runs over the frames read.'
              }
              onClick={() => void s().finishEarly()}
            >
              {props.live ? 'Stop the live run' : 'End pass 1'}
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
          frame {s().processed().toLocaleString()}
          <Show when={!unbounded()}> / {total().toLocaleString()}</Show>
          <Show when={s().fps() > 0}> &middot; {s().fps().toFixed(1)} frames/s</Show>
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
                <For each={metrics()}>
                  {(m) => (
                    <MetricTile
                      title={m.title}
                      value={m.value}
                      hint={m.hint}
                      x={x()}
                      xMax={axisMinutes()}
                      lines={m.lines}
                      range={m.range}
                      testid={m.testid}
                    />
                  )}
                </For>
              </div>
            </Show>
          </>
        }
      >
        <div
          class="cala-run__timeline"
          style={{ '--cala-now': `${(100 * Math.min(1, Math.max(0, nowFraction()))).toFixed(2)}%` }}
        >
          <div class="cala-run__row cala-run__row--pass">
            <span class="cala-run__label">
              <strong>Pass 1</strong> discover
            </span>
            <Show
              when={!unbounded()}
              fallback={<span class="cala-run__live">live: the axis grows as frames arrive</span>}
            >
              <ProgressBar fraction={fraction()} state={pass1State()} aria-label="Pass 1" />
            </Show>
            <span class="cala-run__value">
              {unbounded() ? 'live' : `${Math.round(100 * fraction())}%`}
            </span>
          </div>
          <Show when={!props.live}>
            <div class="cala-run__row cala-run__row--pass">
              <span class="cala-run__label">
                <strong>Pass 2</strong> re-extract
              </span>
              <Show when={pass2Shown()} fallback={<span class="cala-run__track-empty" />}>
                <ProgressBar fraction={pass2Fraction()} state={pass2State()} aria-label="Pass 2" />
              </Show>
              <span class="cala-run__value cala-run__value--muted">{pass2Value()}</span>
            </div>
          </Show>
          <Show when={metricsOpen()}>
            <For each={metrics()}>{(m) => <MetricRow metric={m} x={x()} x1={axisMinutes()} />}</For>
            <div class="cala-run__row cala-run__row--axis" aria-hidden="true">
              <span class="cala-run__label" />
              <span class="cala-run__axis">
                <For each={ticks()}>
                  {(t) => (
                    <span class="cala-run__tick" style={{ left: `${t.f * 100}%` }}>
                      {t.label}
                    </span>
                  )}
                </For>
              </span>
              <span class="cala-run__value cala-run__value--muted">min</span>
            </div>
          </Show>
          <div class="cala-run__now" aria-hidden="true" />
        </div>
      </Show>

      <div class="cala-run__footer">
        <span class="cala-readout" data-testid="cells-readout">
          {c().library()?.ids.length ?? 0} cells &middot; library v{c().version()} &middot; lag{' '}
          {lagNow() ?? 'n/a'} frames
        </span>
        <Show when={props.compress}>
          {(compress) => (
            <span class="cala-readout" data-testid="compress-readout">
              {compress().error() ?? compressReadout(compress().status(), compress().backfill())}
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
