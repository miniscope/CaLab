/**
 * The work display (`beta_speed_control_design.md`, section 3): "Is the machine holding my speed,
 * and what is it doing with the rest?" Work now (one stacked bar), one bar per worker, the history
 * strip over the recording (with the target-change marks and the Final settle segment) and the
 * progress block with the settledness slot.
 *
 * Every range is fixed (no auto-scaling): the work bar and plot run 0 to the number of workers,
 * the speed plot over the slider's 10 to 500 fps log scale, the rows 0 to 100 %. The layout
 * arithmetic is in `lib/work-display.ts` (tested).
 */
import {
  createEffect,
  Index,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  Show,
  untrack,
  type JSX,
} from 'solid-js';
import type { CellStore } from '../lib/cell-store.ts';
import type { PipelineStore } from '../lib/pipeline-store.ts';
import { SETTLE } from '../lib/settle.ts';
import { kindSeriesKey } from '../lib/run-history.ts';
import { normalizeCurve, planLine } from '../lib/speed-schedule.ts';
import { WORK_KIND_LABELS, WORK_KINDS, workByKind, type WorkKind } from '../lib/work-meter.ts';
import {
  bandPath,
  busyWorkers,
  displayState,
  frameTicks,
  gridGroups,
  squareStack,
  squareTitle,
  BG_SETTLE_GROUND,
  BG_SETTLE_HATCH,
  IDLE_COLOR,
  KIND_COLOR,
  linePath,
  planPath,
  plannedSettleFrames,
  rowAriaLabel,
  rowBusy,
  segX,
  speedPos,
  stackBands,
  stoppedLookbackRows,
  stripLayout,
  thinIndices,
  type StackPoint,
} from '../lib/work-display.ts';
import type { HistoryUi } from './HistoryPanel.tsx';

export interface WorkDisplayProps {
  pipeline: PipelineStore;
  cells: CellStore;
  ui: HistoryUi;
  /** A live stream: no total, the shared time window on the strip, no Final settle. */
  live?: boolean;
  /** False while the Run tab is hidden: the strip stops redrawing (default true). */
  visible?: boolean;
}

const KIND_VARS = {
  '--k-live': KIND_COLOR.live,
  '--k-discovery': KIND_COLOR.discovery,
  '--k-lookback': KIND_COLOR.lookback,
  '--k-bg-settle': KIND_COLOR.bgSettle,
  '--k-final-settle': KIND_COLOR.finalSettle,
  '--k-bg-settle-fill': BG_SETTLE_HATCH,
  '--k-spare': IDLE_COLOR,
} as const;

/** HTML fill of a kind: Background settle is hatched, so it differs from Final settle by more than lightness. */
const kindVar = (k: WorkKind): string =>
  k === 'bgSettle'
    ? 'var(--k-bg-settle-fill)'
    : `var(--k-${k === 'finalSettle' ? 'final-settle' : k})`;
/** The same in SVG: a pattern for Background settle (defined in the strip's defs). */
const svgFill = (k: WorkKind): string => (k === 'bgSettle' ? 'url(#cala-work-hatch)' : kindVar(k));

/** What each job is, for the legend's tooltips (the same names as the stages). */
const KIND_HELP: Record<WorkKind, string> = {
  live: 'Discover, per frame: read and prepare each new frame, correct motion, solve the traces.',
  discovery: 'Discover: find new cells and keep the footprints and background up to date.',
  lookback: 'Look-back: re-read earlier frames for each new cell, during Discover.',
  bgSettle: 'Background settle: re-read saved frames to refine footprints, during Discover.',
  finalSettle: 'Final settle: the pass after the last frame that lets the footprints converge.',
};

const n0 = (x: number): string => Math.round(x).toLocaleString('en-US');
const num = (x: number | undefined | null, digits = 2): string =>
  x === undefined || x === null || !Number.isFinite(x) ? '–' : x.toFixed(digits);

/** The strip's fixed rows (px): speed plot, work plot, tick labels. */
const GEO = { left: 34, right: 6, sTop: 14, sBot: 70, wTop: 92, wBot: 136, axis: 148, height: 154 };

const emptyValues = (): Record<WorkKind, number> => ({
  live: 0,
  discovery: 0,
  lookback: 0,
  bgSettle: 0,
  finalSettle: 0,
});

export function WorkDisplay(props: WorkDisplayProps): JSX.Element {
  const s = () => props.pipeline;
  const c = () => props.cells;
  const lb = () => c().status()?.lookback;

  const state = () =>
    displayState({
      status: s().status(),
      live: props.live === true,
      settling: lb()?.settling === true,
    });
  const total = () => s().plan()?.frameCount ?? 0;
  const unbounded = () => !Number.isFinite(total());
  /** The target speed now (0: Max); re-read with each work reading, which comes about once a second. */
  const target = () => s().paceTarget();
  // Paused: the bars keep their last values (the workers go quiet, which is not a reading).
  let lastBy: ReturnType<typeof workByKind> | null = null;
  const by = createMemo(() => {
    const r = s().work();
    if (untrack(() => s().status()) === 'paused' && lastBy) return lastBy;
    lastBy = r ? workByKind(r) : null;
    return lastBy;
  });
  /** The display's beat: a work reading (about 1 Hz) or a status change, never every batch. */
  const beat = () => {
    s().work();
    s().status();
  };
  const dim = () => state() === 'paused' || state() === 'done';
  const idle = () => state() === 'idle';
  const hasFinal = () => !props.live && s().lookbackRun();

  // ---- Work now ----
  const workerCount = () => by()?.count ?? 0;
  const totals = () => by()?.totals;
  const busy = () => {
    const t = totals();
    return t ? busyWorkers(t, workerCount()) : null;
  };
  const groups = () => gridGroups(by());
  const wholeStopped = () => lb()?.error !== undefined;
  const stoppedFlags = createMemo(() =>
    stoppedLookbackRows(by()?.workers ?? [], s().work()?.lookback.capacity, wholeStopped()),
  );
  const statusLine = (): string => {
    switch (state()) {
      case 'idle':
        return 'Not running. The bars fill once a run starts.';
      case 'paused':
        return 'Paused';
      case 'done':
        return 'Done';
      case 'final-settle': {
        const fps = s().work()?.lookback.kinds.end.framesPerS;
        return fps && fps > 0 ? `Final settle ${n0(fps)} frames/s` : 'Final settle';
      }
      case 'streaming':
        return 'Live stream: the input rate sets the pace';
      default:
        return target() > 0
          ? `Paced to ${n0(target())} fps`
          : 'Max: no pacing, all settling after the last frame';
    }
  };

  // ---- History strip ----
  const [width, setWidth] = createSignal(526);
  let ro: ResizeObserver | undefined;
  const bindHost = (el: HTMLDivElement) => {
    if (typeof ResizeObserver === 'undefined') return;
    ro = new ResizeObserver((entries) => {
      const w = Math.floor(entries[0]?.contentRect.width ?? 0);
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    const w = Math.floor(el.getBoundingClientRect().width);
    if (w > 0) setWidth(w);
  };
  onCleanup(() => {
    ro?.disconnect();
  });

  /** Work readings fed during the Final settle (stream time stands still then, so History has none). */
  const [settleSamples, setSettleSamples] = createSignal<StackPoint[]>([]);
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
        const st = lb()?.settle;
        if (!r || state() !== 'final-settle' || !st || st.total <= 0) return;
        const v = workByKind(r).totals;
        const values = emptyValues();
        for (const k of WORK_KINDS) values[k] = v[k];
        setSettleSamples((prev) => [...prev, { x: st.fed / st.total, values }]);
      },
      { defer: true },
    ),
  );

  const compact = () => width() < 420;
  const layout = () => stripLayout(width(), GEO.left, GEO.right, hasFinal());
  /** Seconds the Discover segment spans: the recording from 0, or the shared window of a stream. */
  const axis = () => {
    beat();
    // A recording's end is fixed at the run's start. The shared History helpers read the
    // per-batch tick, which this display does not follow: it redraws on the beat.
    const end = props.ui.run.runEnd();
    return untrack(() => {
      if (props.live) {
        const sp = props.ui.span();
        return { a0: sp.t0, a1: Math.max(sp.t1, sp.t0 + 1e-6) };
      }
      return { a0: 0, a1: Math.max(end ?? props.ui.run.now(), 1e-6) };
    });
  };
  const fps = () => props.ui.run.fps();
  const xOfT = (t: number) => segX(layout().discover, t - axis().a0, axis().a1 - axis().a0);

  interface Strip {
    speed: { target: string; achieved: string };
    bands: { kind: WorkKind; d: string }[];
  }
  let lastStrip: Strip = { speed: { target: '', achieved: '' }, bands: [] };
  const strip = createMemo((): Strip => {
    if (props.visible === false) return lastStrip;
    const run = props.ui.run;
    beat();
    const h = run.history();
    const staticAx = axis();
    const lay = layout();
    const maxBins = Math.max(8, Math.min(240, Math.floor((lay.discover.x1 - lay.discover.x0) / 2)));
    const views = WORK_KINDS.map((k) =>
      h.view(kindSeriesKey(k), staticAx.a0, staticAx.a1, maxBins),
    );
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
    const count = Math.max(1, workerCount());
    const bands = stackBands(points, count, GEO.wTop, GEO.wBot).map((b) => ({
      kind: b.kind,
      d: bandPath(b),
    }));
    // The Final settle segment: the readings fed during it, x = settle frames fed of the plan.
    const fin = lay.final;
    const samples = settleSamples();
    if (fin && samples.length > 0) {
      const pts = thinIndices(samples.length, 200).map((i) => ({
        x: fin.x0 + (fin.x1 - fin.x0) * samples[i].x,
        values: samples[i].values,
      }));
      const fb = stackBands(pts, count, GEO.wTop, GEO.wBot);
      for (const b of fb) {
        const d = bandPath(b);
        if (d) bands.push({ kind: b.kind, d });
      }
    }
    // Speed lines on the fixed log scale: Max (stored as 0) sits at the top.
    const yS = (v: number) => GEO.sBot - (GEO.sBot - GEO.sTop) * speedPos(v > 0 ? v : Infinity);
    const line = (key: string, which: 'mean' | 'last', maxZeroIsTop: boolean) => {
      const v = h.view(key, staticAx.a0, staticAx.a1, maxBins);
      if (!v) return '';
      const xs: number[] = [];
      const ys: number[] = [];
      for (let i = 0; i < v.n; i++) {
        const m = v[which][i];
        xs.push(xOfT(v.t0 + (i + 0.5) * v.binS));
        ys.push(Number.isFinite(m) ? (maxZeroIsTop || m > 0 ? yS(m) : NaN) : NaN);
      }
      return linePath(xs, ys);
    };
    lastStrip = {
      speed: {
        target: line('target_fps', 'last', true),
        achieved: line('proc_fps', 'mean', false),
      },
      bands,
    };
    return lastStrip;
  });

  /**
   * The curve's plan over the whole recording (Curve mode, recordings only): what the run follows
   * once it starts (steps too short for the governor's ramp already merged), with the symbols
   * (the floor, every frame seen) read at their latest values.
   */
  const plan = createMemo(() => {
    beat();
    if (props.live) return '';
    const c = s().speedCurve();
    if (!c) return '';
    const f = s().floor();
    const live = { floorFps: f.fps, seeAllFps: f.estimate.seeAllFps };
    const armed = s().curveNow();
    let points = armed ? armed.effective_points : c.curve.points;
    if (!armed && c.normalize && total() > 0 && !unbounded())
      points = normalizeCurve(c.curve, {
        totalFrames: total(),
        cap: s().csettle() ? s().csettleCeiling() : 0,
        ...live,
        maxFps: s().workMaxFps() > 0 ? s().workMaxFps() : null,
      }).curve.points;
    return planPath(planLine({ points }, live), layout().discover, GEO.sTop, GEO.sBot);
  });

  const marks = createMemo(() => {
    const run = props.ui.run;
    beat();
    const { a0, a1 } = axis();
    const out: { x: number; label: string }[] = [];
    let lastLabelX = -Infinity;
    for (const e of run.events().list()) {
      if (e.kind !== 'setting' || e.key !== 'target_speed' || e.t < a0 || e.t > a1) continue;
      const x = xOfT(e.t);
      const label =
        typeof e.to === 'number' ? (e.to > 0 ? `${n0(e.to)} fps` : 'Max') : String(e.to ?? '');
      const room = x - lastLabelX > 64 && x < layout().discover.x1 - 48;
      if (room) lastLabelX = x;
      out.push({ x, label: room ? label : '' });
    }
    return out;
  });
  const nowX = () => {
    beat();
    if (props.live || idle()) return null;
    return xOfT(untrack(() => props.ui.run.now()));
  };
  const inspectedX = () => {
    const t = props.ui.window.inspected();
    if (t === null || t === undefined || props.live) return null;
    return t >= axis().a0 && t <= axis().a1 ? xOfT(t) : null;
  };
  const ticks = () => {
    const frames = (axis().a1 - axis().a0) * fps();
    const maxT = width() < 360 ? 2 : width() < 480 ? 3 : 5;
    return frameTicks(Math.floor(frames), maxT).map((f) => ({
      f,
      x: xOfT(axis().a0 + f / fps()),
    }));
  };
  const speedTicks = [30, 100, 300];
  /** The floor as a dotted reference (the Speed control's floor; the prior until a measurement). */
  const floorY = () => {
    if (idle() || props.live) return null;
    const f = s().floor().fps;
    return f > 0 ? GEO.sBot - (GEO.sBot - GEO.sTop) * speedPos(f) : null;
  };
  const yS = (v: number) => GEO.sBot - (GEO.sBot - GEO.sTop) * speedPos(v);
  const N = () => Math.max(1, workerCount());
  /** The Final settle's planned frames (the strip's settle segment axis). */
  const settleTotal = () => lb()?.settle?.total ?? plannedSettleFrames(total(), SETTLE.maxFrames);
  const stripEnd = () =>
    props.live ? 'live window' : `frame ${n0(s().processed())} of ${n0(total())}`;

  return (
    <div
      class="cala-work"
      classList={{ 'cala-work--dim': dim(), 'cala-work--idle': idle() }}
      style={KIND_VARS}
      data-testid="work-display"
      data-state={state()}
    >
      {/* ---- Workers: one square per worker, like a CPU monitor ---- */}
      <section class="cala-work__block" aria-label="Workers">
        <div class="cala-work__head">
          <h3 class="cala-work__title">Workers</h3>
          <span
            class="cala-work__aside"
            data-testid="work-busy"
            title="The workers' busy shares over the last second, added up: 2.5 means two and a half workers' worth of time was in use."
          >
            <span class="cala-num">{num(busy(), 1)}</span> of{' '}
            <span class="cala-num">{workerCount() > 0 ? workerCount() : '–'}</span> workers busy
          </span>
        </div>
        <p class="cala-work__status" data-testid="work-status">
          {statusLine()}
        </p>
        <p class="cala-work__caption" data-testid="work-caption">
          Each square is one worker (a browser thread). It fills from the bottom with one colour per
          job, each as tall as that job's share of the last second; the number is how busy the
          worker was over that second (100 %: the whole second). Hover a square for details. Extract
          is not shown: it runs after Discover, on its own.
        </p>
        <div class="cala-work__cores" data-testid="work-grid">
          <Index each={groups()}>
            {(g) => (
              <div class="cala-work__group">
                <span class="cala-work__group-label">{g().label}</span>
                <div class="cala-work__squares">
                  <Index each={g().squares}>
                    {(sq) => {
                      const stopped = () => stoppedFlags()[sq().index] === true;
                      const busyPct = () => Math.round(100 * rowBusy(sq().row));
                      return (
                        <div
                          class="cala-work__sq"
                          classList={{ 'cala-work__sq--stopped': stopped() }}
                          role="img"
                          aria-label={
                            stopped()
                              ? `${sq().label}: stopped`
                              : rowAriaLabel(sq().label, sq().row)
                          }
                          title={
                            stopped()
                              ? `${sq().label}: stopped (see the console).`
                              : squareTitle(sq().label, sq().row)
                          }
                          data-testid="work-square"
                          data-state={stopped() ? 'stopped' : busyPct() > 0 ? 'busy' : 'idle'}
                        >
                          <Show when={!stopped()}>
                            <span class="cala-work__fill">
                              <Index each={squareStack(sq().row)}>
                                {(seg) => (
                                  <i
                                    data-kind={seg().kind}
                                    style={{
                                      height: `${seg().pct}%`,
                                      background: kindVar(seg().kind),
                                    }}
                                  />
                                )}
                              </Index>
                            </span>
                          </Show>
                          <span class="cala-work__pct cala-num" data-testid="work-square-pct">
                            {stopped() ? '✕' : busyPct()}
                          </span>
                        </div>
                      );
                    }}
                  </Index>
                </div>
              </div>
            )}
          </Index>
          <Show when={groups().length === 0}>
            <p class="cala-work__empty">The workers show once a run starts.</p>
          </Show>
        </div>
        <ul class="cala-work__legend" data-testid="work-legend" aria-label="Jobs">
          <For each={WORK_KINDS}>
            {(k) => (
              <li title={KIND_HELP[k]}>
                <i class="cala-work__sw" style={{ background: kindVar(k) }} />
                {WORK_KIND_LABELS[k]}
              </li>
            )}
          </For>
          <li title="Not busy with any job.">
            <i class="cala-work__sw cala-work__sw--spare" />
            {WORK_KIND_LABELS.spare}
          </li>
        </ul>
      </section>

      {/* ---- History strip ---- */}
      <section class="cala-work__block" aria-label="Over the recording">
        <div class="cala-work__head">
          <h3 class="cala-work__title">{props.live ? 'Over the stream' : 'Over the recording'}</h3>
          <span class="cala-work__aside cala-num">{idle() ? '–' : stripEnd()}</span>
        </div>
        <div class="cala-work__strip" ref={bindHost}>
          <svg
            width={width()}
            height={GEO.height}
            viewBox={`0 0 ${width()} ${GEO.height}`}
            role="img"
            aria-label="Target and achieved speed, and work by kind, over the recording"
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
            </defs>
            <text x={GEO.left} y="9">
              {compact()
                ? 'fps (10 to 500)'
                : plan()
                  ? 'fps, fixed 10 to 500: plan long dashes, target short dashes, achieved solid'
                  : 'fps, fixed 10 to 500: target dashed, achieved solid'}
            </text>
            <For each={speedTicks}>
              {(t) => (
                <>
                  <line
                    class="cala-work__grid"
                    x1={GEO.left}
                    x2={width() - GEO.right}
                    y1={yS(t)}
                    y2={yS(t)}
                  />
                  <text x={GEO.left - 4} y={yS(t) + 3} text-anchor="end">
                    {t}
                  </text>
                </>
              )}
            </For>
            <rect
              class="cala-work__track"
              x={GEO.left}
              y={GEO.wTop}
              width={Math.max(0, layout().discover.x1 - GEO.left)}
              height={GEO.wBot - GEO.wTop}
            />
            <Show when={layout().final}>
              {(f) => (
                <>
                  <rect
                    class="cala-work__track cala-work__track--final"
                    x={f().x0}
                    y={GEO.wTop}
                    width={f().x1 - f().x0}
                    height={GEO.wBot - GEO.wTop}
                  />
                  <text x={f().x0} y={GEO.sTop - 5}>
                    Final settle
                  </text>
                  <Show when={!compact()}>
                    <text x={f().x0} y={GEO.axis} text-anchor="start">
                      0
                    </text>
                  </Show>
                  <text x={f().x1} y={GEO.axis} text-anchor="end">
                    {n0(settleTotal())}
                  </text>
                </>
              )}
            </Show>
            <Show when={floorY()}>
              {(y) => (
                <>
                  <line
                    class="cala-work__floor"
                    x1={GEO.left}
                    x2={width() - GEO.right}
                    y1={y()}
                    y2={y()}
                    data-testid="work-floor"
                  />
                  <text x={width() - GEO.right} y={y() - 3} text-anchor="end">
                    {`floor ${n0(s().floor().fps)}`}
                  </text>
                </>
              )}
            </Show>
            <Show when={plan()}>
              <path
                class="cala-work__line cala-work__line--plan"
                d={plan()}
                data-testid="work-plan"
              />
            </Show>
            <path class="cala-work__line cala-work__line--target" d={strip().speed.target} />
            <path class="cala-work__line cala-work__line--achieved" d={strip().speed.achieved} />
            <For each={strip().bands}>
              {(b) => <path d={b.d} fill={svgFill(b.kind)} data-kind={b.kind} />}
            </For>
            <text x={GEO.left} y={GEO.wTop - 4}>
              {compact()
                ? `workers busy (0 to ${workerCount() > 0 ? workerCount() : '–'})`
                : `workers busy, by kind (fixed 0 to ${workerCount() > 0 ? workerCount() : '–'} workers)`}
            </text>
            <text x={GEO.left - 4} y={GEO.wBot + 3} text-anchor="end">
              0 w
            </text>
            <text x={GEO.left - 4} y={GEO.wTop + 4} text-anchor="end">
              {workerCount() > 0 ? `${N()} w` : ''}
            </text>
            <For each={marks()}>
              {(m) => (
                <>
                  <line
                    class="cala-work__mark"
                    x1={m.x}
                    x2={m.x}
                    y1={GEO.sTop}
                    y2={GEO.wBot}
                    data-testid="work-mark"
                  />
                  <Show when={m.label}>
                    <text class="cala-work__mark-label" x={m.x + 4} y={GEO.sTop + 8}>
                      {m.label}
                    </text>
                  </Show>
                </>
              )}
            </For>
            <Show when={inspectedX()}>
              {(x) => (
                <line
                  class="cala-work__mark cala-work__mark--dotted"
                  x1={x()}
                  x2={x()}
                  y1={GEO.sTop}
                  y2={GEO.wBot}
                />
              )}
            </Show>
            <Show when={nowX()}>
              {(x) => <line class="cala-work__now" x1={x()} x2={x()} y1={GEO.sTop} y2={GEO.wBot} />}
            </Show>
            <For each={ticks()}>
              {(t) => (
                <text x={t.x} y={GEO.axis} text-anchor={t.f === 0 ? 'start' : 'middle'}>
                  {n0(t.f)}
                </text>
              )}
            </For>
          </svg>
        </div>
      </section>
    </div>
  );
}
