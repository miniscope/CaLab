/**
 * The Run tab's time strip: the convergence plot, the speed (target and achieved) and the work
 * by kind, stacked on one shared x axis (the History time window, stream time) with one set of
 * time labels under the last row. A recording with look-back keeps a Final settle column on the
 * right, on its own axis (settle frames fed of the plan), because stream time stands still then.
 *
 * Every range is fixed: the speed row runs over the Speed track's 10 to 500 fps log scale, the
 * work row 0 to the number of workers. Everything is redrawn from one snapshot taken at most
 * twice a second (and at once on a change of stage, window, inspected time or width), never
 * per batch. The layout arithmetic is in `lib/work-display.ts` and `@calab/ui/chart` (tested).
 */
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from 'solid-js';
import type { JSX } from 'solid-js';
import { SegmentedControl } from '@calab/ui';
import {
  HISTORY_GUTTER_PX,
  HistoryPlot,
  placeAxisLabels,
  timeTicks,
  windowPresets,
  type AxisLabel,
  type AxisLabelCandidate,
} from '@calab/ui/chart';
import type { CellStore } from '../lib/cell-store.ts';
import type { PipelineStore } from '../lib/pipeline-store.ts';
import { groupKeys, kindSeriesKey } from '../lib/run-history.ts';
import { createSampled } from '../lib/sampled.ts';
import { SETTLE } from '../lib/settle.ts';
import { normalizeCurve, planLine } from '../lib/speed-schedule.ts';
import { WORK_KINDS, workByKind, type WorkKind } from '../lib/work-meter.ts';
import {
  bandPath,
  BG_SETTLE_GROUND,
  KIND_COLOR,
  linePath,
  planPath,
  plannedSettleFrames,
  speedPos,
  stackBands,
  stepPoints,
  stripLayout,
  thinIndices,
  type StackPoint,
  type StripLayout,
} from '../lib/work-display.ts';
import { RunStrip, type HistoryUi } from './HistoryPanel.tsx';
import { kindFill } from './WorkDisplay.tsx';

/** Live figures refresh at most this often, ms (2 Hz). */
const SAMPLE_MS = 500;

/** Width drawn before the strip is measured (and where nothing can measure it), px. */
const DEFAULT_WIDTH_PX = 520;

/** Height of the convergence plot, px (one small multiple of the strip). */
const CONVERGENCE_PX = 96;

/** The SVG rows (px): speed row, work row, the time labels. */
const GEO = {
  sLabel: 9,
  sTop: 14,
  sBot: 62,
  wLabel: 76,
  wTop: 81,
  wBot: 129,
  axis: 142,
  height: 147,
} as const;

/** The speed row's grid values, fps. */
const SPEED_GRID = [30, 100, 300];

const n0 = (x: number): string => Math.round(x).toLocaleString('en-US');

const emptyValues = (): Record<WorkKind, number> => ({
  live: 0,
  discovery: 0,
  lookback: 0,
  bgSettle: 0,
  finalSettle: 0,
});

export interface TimeStripProps {
  pipeline: PipelineStore;
  cells: CellStore;
  ui: HistoryUi;
  /** A live stream: the shared window only, no Final settle column. */
  live?: boolean;
  /** False while the Run tab is hidden: nothing is redrawn (default true). */
  visible?: boolean;
}

interface Snapshot {
  span: { t0: number; t1: number };
  now: number;
  tick: number;
  width: number;
  layout: StripLayout;
  bands: { kind: WorkKind; d: string }[];
  target: string;
  achieved: string;
  /** The Final settle's frames/s over its pass, in its column. */
  settleFps: string;
  marks: { x: number; label: string }[];
  nowX: number | null;
  floorY: number | null;
  floorFps: number;
  grid: number[];
  labels: AxisLabel[];
  workers: number;
  frame: string;
}

export function TimeStrip(props: TimeStripProps): JSX.Element {
  const s = () => props.pipeline;
  const c = () => props.cells;
  const run = () => props.ui.run;
  const win = () => props.ui.window;
  const shown = () => props.visible !== false;
  const idle = () => s().status() === 'idle';
  const hasFinal = () => !props.live && s().lookbackRun();
  const total = () => s().plan()?.frameCount ?? 0;

  // ---- width (the side column's usual width until the first measurement) ----
  const [width, setWidth] = createSignal(DEFAULT_WIDTH_PX);
  let ro: ResizeObserver | undefined;
  const bindHost = (el: HTMLDivElement) => {
    const measure = () => {
      const w = Math.floor(el.getBoundingClientRect().width);
      // Hidden (a tab not shown): keep the last width.
      if (w > 0) setWidth(w);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    ro = new ResizeObserver(measure);
    ro.observe(el);
  };
  onCleanup(() => ro?.disconnect());

  // ---- Final settle readings (stream time stands still then, so History has none) ----
  const [settleSamples, setSettleSamples] = createSignal<(StackPoint & { fps: number })[]>([]);
  createEffect(
    on(
      () => s().status(),
      (st) => {
        if (st === 'starting') setSettleSamples([]);
      },
    ),
  );
  createEffect(
    on(
      () => s().work(),
      (r) => {
        const lb = c().status()?.lookback;
        const st = lb?.settle;
        if (!r || s().status() !== 'done' || lb?.settling !== true || !st || st.total <= 0) return;
        const v = workByKind(r).totals;
        const values = emptyValues();
        for (const k of WORK_KINDS) values[k] = v[k];
        const fps = r.lookback.kinds.end.framesPerS ?? 0;
        setSettleSamples((prev) => [...prev, { x: st.fed / st.total, values, fps }]);
      },
      { defer: true },
    ),
  );

  /** What wakes the snapshot at once: a change of stage, window, inspected time, width or tab. */
  const key = () => {
    const w = win().state;
    return [
      s().status(),
      c().status()?.lookback?.settling === true,
      w.mode,
      w.lastS,
      w.t0,
      w.t1,
      win().inspected(),
      width(),
      shown(),
      hasFinal(),
    ].join('|');
  };

  let last: Snapshot | null = null;
  const read = (): Snapshot => {
    if (!shown() && last) return last;
    const r = run();
    const h = r.history();
    const W = width();
    const lay = stripLayout(W, HISTORY_GUTTER_PX, 0, hasFinal());
    const span = props.ui.span();
    const a0 = span.t0;
    const a1 = Math.max(span.t1, a0 + 1e-6);
    const seg = lay.discover;
    const xOfT = (t: number) => seg.x0 + ((t - a0) / (a1 - a0)) * (seg.x1 - seg.x0);
    const workerCount = s().work() ? workByKind(s().work()!).count : 0;
    const count = Math.max(1, workerCount);
    const maxBins = Math.max(8, Math.min(240, Math.floor((seg.x1 - seg.x0) / 2)));

    // Work by kind: each reading drawn as a step back to the one before.
    const views = WORK_KINDS.map((k) => h.view(kindSeriesKey(k), a0, a1, maxBins));
    const first = views.find((v) => v !== null) ?? null;
    const points: StackPoint[] = [];
    if (first) {
      for (let i = 0; i < first.n; i++) {
        const t = first.t0 + (i + 0.5) * first.binS;
        const values = emptyValues();
        let any = false;
        WORK_KINDS.forEach((k, j) => {
          const m = views[j]?.mean[i];
          if (m !== undefined && Number.isFinite(m)) {
            values[k] = m;
            any = true;
          }
        });
        if (any) points.push({ x: xOfT(t), values });
      }
    }
    const open = r.workStart();
    if (open !== null && points.length > 0) {
      const x0 = xOfT(Math.max(open, a0));
      if (x0 < points[0].x) points.unshift({ x: x0, values: points[0].values });
    }
    const bands = stackBands(stepPoints(points), count, GEO.wTop, GEO.wBot)
      .map((b) => ({ kind: b.kind, d: bandPath(b) }))
      .filter((b) => b.d !== '');
    // Speed lines on the fixed log scale: Max (stored as 0) sits at the top.
    const yS = (v: number) => GEO.sBot - (GEO.sBot - GEO.sTop) * speedPos(v > 0 ? v : Infinity);
    const fin = lay.final;
    const samples = settleSamples();
    let settleFps = '';
    if (fin && samples.length > 0) {
      const pts = thinIndices(samples.length, 200).map((i) => ({
        x: fin.x0 + (fin.x1 - fin.x0) * Math.min(1, samples[i].x),
        values: samples[i].values,
        fps: samples[i].fps,
      }));
      for (const b of stackBands(stepPoints(pts), count, GEO.wTop, GEO.wBot)) {
        const d = bandPath(b);
        if (d) bands.push({ kind: b.kind, d });
      }
      settleFps = linePath(
        pts.map((q) => q.x),
        pts.map((q) => (q.fps > 0 ? yS(q.fps) : NaN)),
      );
    }

    const line = (k: string, which: 'mean' | 'last', zeroIsMax: boolean) => {
      const v = h.view(k, a0, a1, maxBins);
      if (!v) return '';
      const xs: number[] = [];
      const ys: number[] = [];
      for (let i = 0; i < v.n; i++) {
        const m = v[which][i];
        xs.push(xOfT(v.t0 + (i + 0.5) * v.binS));
        ys.push(Number.isFinite(m) ? (zeroIsMax || m > 0 ? yS(m) : NaN) : NaN);
      }
      return linePath(xs, ys);
    };

    // Target changes, labelled where there is room.
    const marks: { x: number; label: string }[] = [];
    let lastLabelX = -Infinity;
    for (const e of r.events().list()) {
      if (e.kind !== 'setting' || e.key !== 'target_speed' || e.t < a0 || e.t > a1) continue;
      const x = xOfT(e.t);
      const label =
        typeof e.to === 'number' ? (e.to > 0 ? `${n0(e.to)} fps` : 'Max') : String(e.to ?? '');
      const room = x - lastLabelX > 64 && x < seg.x1 - 48;
      if (room) lastLabelX = x;
      marks.push({ x, label: room ? label : '' });
    }

    // One set of time labels for every row; the Final settle column's ends win at the seam.
    const pw = seg.x1 - seg.x0;
    const ticks = timeTicks(a0, a1, pw);
    const candidates: AxisLabelCandidate[] = ticks.map((tk) => ({ x: xOfT(tk.t), text: tk.label }));
    const settleTotal =
      c().status()?.lookback?.settle?.total || plannedSettleFrames(total(), SETTLE.maxFrames);
    if (fin) {
      candidates.push({ x: fin.x0, text: '0', anchor: 'start', priority: 1 });
      candidates.push({ x: fin.x1, text: `${n0(settleTotal)} fr`, anchor: 'end', priority: 1 });
    }
    const labels = placeAxisLabels(candidates, { x0: 0, x1: W, charPx: 6, gap: 6 });

    const floorFps = s().floor().fps;
    const live = props.live === true;
    const status = s().status();
    const processed = s().processed();
    last = {
      span: { t0: a0, t1: a1 },
      now: r.now(),
      tick: r.tick(),
      width: W,
      layout: lay,
      bands,
      settleFps,
      target: line('target_fps', 'last', true),
      achieved: line('proc_fps', 'mean', false),
      marks,
      nowX: live || status === 'idle' ? null : xOfT(Math.min(a1, r.now())),
      floorY:
        status === 'idle' || live || !(floorFps > 0)
          ? null
          : GEO.sBot - (GEO.sBot - GEO.sTop) * speedPos(floorFps),
      floorFps,
      grid: ticks.map((tk) => xOfT(tk.t)),
      labels,
      workers: workerCount,
      frame: live ? 'live window' : `frame ${n0(processed)} of ${n0(total())}`,
    };
    return last;
  };
  const snap = createSampled(read, key, SAMPLE_MS);

  /**
   * The curve's plan over the recording (Curve mode, recordings only): what the run follows once
   * it starts, with the floor and "every frame seen" at their latest values. Mapped through the
   * window, so it lines up with the other rows.
   */
  const plan = createMemo(() => {
    if (props.live) return '';
    const curve = s().speedCurve();
    if (!curve) return '';
    const f = s().floor();
    const liveNow = { floorFps: f.fps, seeAllFps: f.estimate.seeAllFps };
    const armed = s().curveNow();
    let points = armed ? armed.effective_points : curve.curve.points;
    const n = total();
    if (!armed && curve.normalize && n > 0 && Number.isFinite(n))
      points = normalizeCurve(curve.curve, {
        totalFrames: n,
        cap: s().csettle() ? s().csettleCeiling() : 0,
        ...liveNow,
        maxFps: s().workMaxFps() > 0 ? s().workMaxFps() : null,
      }).curve.points;
    const v = snap();
    const end = run().runEnd() ?? v.span.t1;
    const seg = v.layout.discover;
    const xOfT = (t: number) =>
      seg.x0 + ((t - v.span.t0) / (v.span.t1 - v.span.t0)) * (seg.x1 - seg.x0);
    return planPath(
      planLine({ points }, liveNow),
      { x0: xOfT(0), x1: xOfT(end) },
      GEO.sTop,
      GEO.sBot,
    );
  });

  // ---- the shared window control ----
  const windowValue = () => {
    const st = win().state;
    return st.mode === 'last' ? `last-${st.lastS}` : st.mode;
  };
  const windowOptions = () => [
    { value: 'run', label: 'Whole run', title: 'The whole run (a file: to its end; live: to now)' },
    ...windowPresets(props.ui.axisEnd()).map((p) => ({
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

  const inspectedX = () => {
    const t = win().inspected();
    const v = snap();
    if (t === null || t === undefined || props.live) return null;
    if (t < v.span.t0 || t > v.span.t1) return null;
    const seg = v.layout.discover;
    return seg.x0 + ((t - v.span.t0) / (v.span.t1 - v.span.t0)) * (seg.x1 - seg.x0);
  };
  const yS = (v: number) => GEO.sBot - (GEO.sBot - GEO.sTop) * speedPos(v);
  const compact = () => snap().width < 420;
  const N = () => snap().workers;
  const keys = createMemo(() => groupKeys('convergence', run().live()));
  const disc = () => snap().layout.discover;
  const fin = () => snap().layout.final;

  return (
    <section
      class="cala-tstrip"
      classList={{ 'cala-tstrip--idle': idle() }}
      aria-label={props.live ? 'Over the stream' : 'Over the recording'}
      data-testid="time-strip"
    >
      <div class="cala-tstrip__head">
        <h3 class="cala-tstrip__title">{props.live ? 'Over the stream' : 'Over the recording'}</h3>
        <span class="cala-tstrip__aside num">{idle() ? '–' : snap().frame}</span>
      </div>
      <div class="cala-tstrip__window">
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
      <div class="cala-tstrip__body" ref={bindHost}>
        <Show when={shown() && !props.ui.expanded() && snap().width > 0 && keys().length > 0}>
          <div class="cala-tstrip__conv">
            <div class="cala-tstrip__conv-plot" style={{ width: `${disc().x1}px` }}>
              <HistoryPlot
                history={() => run().history()}
                keys={keys()}
                window={() => snap().span}
                now={() => snap().now}
                runEnd={() => run().runEnd()}
                events={props.ui.events}
                tick={() => snap().tick}
                height={CONVERGENCE_PX}
                selected={() => props.ui.selected('convergence') ?? keys()[0]}
                onSelect={(k) => props.ui.select('convergence', k)}
                inspected={win().inspected}
                onInspect={(t) => win().setInspected(t)}
                clockAt={(t) => run().clockAt(t)}
                onBrush={(a, b) => win().setBrush(a, b)}
                onResetWindow={() => win().setRun()}
                compact
                timeAxis={false}
                label="Convergence"
                testid="history-convergence"
                onDraw={(ms) => (props.ui.drawMs['convergence-run'] = ms)}
              />
            </div>
            <Show when={fin()}>
              {(f) => (
                <div
                  class="cala-tstrip__final"
                  style={{ left: `${f().x0}px`, width: `${f().x1 - f().x0}px` }}
                  data-testid="time-strip-final"
                  title="The Final settle reads the recording again with the cell set frozen; its rows below run over the settle's frames, not over time."
                >
                  <span class="cala-tstrip__final-title">Final settle</span>
                  <span class="cala-tstrip__final-note">cell set frozen</span>
                </div>
              )}
            </Show>
          </div>
        </Show>
        <Show when={snap().width > 0}>
          <svg
            width={snap().width}
            height={GEO.height}
            viewBox={`0 0 ${snap().width} ${GEO.height}`}
            role="img"
            aria-label="Target and achieved speed, and workers busy by kind, on the same time axis as the convergence plot"
            data-testid="work-strip"
          >
            <defs>
              <pattern
                id="cala-work-hatch"
                width="5"
                height="5"
                patternUnits="userSpaceOnUse"
                patternTransform="rotate(45)"
              >
                <rect width="5" height="5" style={{ fill: BG_SETTLE_GROUND }} />
                <rect width="2" height="5" style={{ fill: KIND_COLOR.bgSettle }} />
              </pattern>
              <clipPath id="cala-tstrip-discover">
                <rect x={disc().x0} y={0} width={disc().x1 - disc().x0} height={GEO.height} />
              </clipPath>
            </defs>

            {/* Row titles and fixed-range labels in the gutter. */}
            <text class="cala-tstrip__row-title" x={disc().x0} y={GEO.sLabel}>
              {compact()
                ? 'fps, log 10–500'
                : plan()
                  ? 'fps, log 10–500: plan long dashes, target short dashes, achieved solid'
                  : 'fps, log 10–500: target dashed, achieved solid'}
            </text>
            <text class="cala-tstrip__row-title" x={disc().x0} y={GEO.wLabel}>
              {compact() ? 'workers busy' : 'workers busy, by kind (colours as in Compute)'}
            </text>
            <For each={SPEED_GRID}>
              {(t) => (
                <>
                  <line
                    class="cala-tstrip__grid"
                    x1={disc().x0}
                    x2={disc().x1}
                    y1={yS(t)}
                    y2={yS(t)}
                  />
                  <Show when={fin()}>
                    {(f) => (
                      <line
                        class="cala-tstrip__grid"
                        x1={f().x0}
                        x2={f().x1}
                        y1={yS(t)}
                        y2={yS(t)}
                      />
                    )}
                  </Show>
                  <text x={disc().x0 - 4} y={yS(t) + 3} text-anchor="end">
                    {t}
                  </text>
                </>
              )}
            </For>
            <text x={disc().x0 - 4} y={GEO.wBot + 3} text-anchor="end">
              0
            </text>
            <text x={disc().x0 - 4} y={GEO.wTop + 7} text-anchor="end">
              {N() > 0 ? n0(N()) : '–'}
            </text>
            <rect
              class="cala-tstrip__track"
              x={disc().x0}
              y={GEO.wTop}
              width={Math.max(0, disc().x1 - disc().x0)}
              height={GEO.wBot - GEO.wTop}
            />
            <For each={snap().grid}>
              {(x) => <line class="cala-tstrip__grid" x1={x} x2={x} y1={GEO.sTop} y2={GEO.wBot} />}
            </For>
            <Show when={fin()}>
              {(f) => (
                <>
                  <rect
                    class="cala-tstrip__track cala-tstrip__track--final"
                    x={f().x0}
                    y={GEO.sTop}
                    width={f().x1 - f().x0}
                    height={GEO.sBot - GEO.sTop}
                  />
                  <rect
                    class="cala-tstrip__track cala-tstrip__track--final"
                    x={f().x0}
                    y={GEO.wTop}
                    width={f().x1 - f().x0}
                    height={GEO.wBot - GEO.wTop}
                  />
                </>
              )}
            </Show>
            <Show when={snap().floorY}>
              {(y) => (
                <>
                  <line
                    class="cala-tstrip__floor"
                    x1={disc().x0}
                    x2={disc().x1}
                    y1={y()}
                    y2={y()}
                    data-testid="work-floor"
                  />
                  <text x={disc().x1 - 2} y={y() - 3} text-anchor="end">
                    {`floor ${n0(snap().floorFps)}`}
                  </text>
                </>
              )}
            </Show>
            <path
              class="cala-tstrip__line cala-tstrip__line--settle"
              d={snap().settleFps}
              data-testid="settle-rate"
            />
            <g clip-path="url(#cala-tstrip-discover)">
              <Show when={plan()}>
                <path
                  class="cala-tstrip__line cala-tstrip__line--plan"
                  d={plan()}
                  data-testid="work-plan"
                />
              </Show>
              <path class="cala-tstrip__line cala-tstrip__line--target" d={snap().target} />
              <path class="cala-tstrip__line cala-tstrip__line--achieved" d={snap().achieved} />
            </g>
            <For each={snap().bands}>
              {(b) => <path d={b.d} fill={kindFill(b.kind, 'svg')} data-kind={b.kind} />}
            </For>
            <For each={snap().marks}>
              {(m) => (
                <>
                  <line
                    class="cala-tstrip__mark"
                    x1={m.x}
                    x2={m.x}
                    y1={GEO.sTop}
                    y2={GEO.wBot}
                    data-testid="work-mark"
                  />
                  <Show when={m.label}>
                    <text class="cala-tstrip__mark-label" x={m.x + 4} y={GEO.sTop + 8}>
                      {m.label}
                    </text>
                  </Show>
                </>
              )}
            </For>
            <Show when={inspectedX()}>
              {(x) => (
                <line
                  class="cala-tstrip__mark cala-tstrip__mark--inspected"
                  x1={x()}
                  x2={x()}
                  y1={GEO.sTop}
                  y2={GEO.wBot}
                />
              )}
            </Show>
            <Show when={snap().nowX}>
              {(x) => (
                <line class="cala-tstrip__now" x1={x()} x2={x()} y1={GEO.sTop} y2={GEO.wBot} />
              )}
            </Show>
            <For each={snap().labels}>
              {(l) => (
                <text x={l.x} y={GEO.axis} text-anchor={l.anchor}>
                  {l.text}
                </text>
              )}
            </For>
          </svg>
        </Show>
      </div>
    </section>
  );
}
