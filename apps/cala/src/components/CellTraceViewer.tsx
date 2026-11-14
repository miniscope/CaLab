import { plotHeight } from '../lib/plot-size.tsx';
import { createEffect, createMemo, createSignal, on, onCleanup, Show, type JSX } from 'solid-js';
import { OKABE_ITO, TraceOverview, ZoomWindow } from '@calab/ui/chart';
import type { BoundarySeverity } from '../lib/boundary-flags.ts';
import { downsampleMinMax } from '@calab/compute';
import type uPlot from 'uplot';
import type { CellStore } from '../lib/cell-store.ts';

/** Width of the zoom window when a cell is first shown, seconds. */
const DEFAULT_WINDOW_S = 30;
/** Points the zoom window draws at most (min/max pairs per bucket). */
const ZOOM_BUCKETS = 800;
/** The zoom plot fills the height the window leaves it, within these bounds. */
const ZOOM_MIN = 160;
const ZOOM_MAX = 420;
/** Height of everything else on the screen (header, strips, footprint, QC), px. */
const ZOOM_RESERVED = 700;
function zoomHeight(): number {
  const h = typeof window === 'undefined' ? 900 : window.innerHeight;
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, h - ZOOM_RESERVED));
}

/** Vertical line at `time()` (seconds) on a uPlot chart. */
function markerPlugin(time: () => number | null): uPlot.Plugin {
  return {
    hooks: {
      draw: (u) => {
        const t = time();
        if (t === null) return;
        const x = u.valToPos(t, 'x', true);
        if (x < u.bbox.left || x > u.bbox.left + u.bbox.width) return;
        const ctx = u.ctx;
        ctx.save();
        ctx.strokeStyle = OKABE_ITO.blue;
        ctx.lineWidth = 2 * devicePixelRatio;
        ctx.setLineDash([4 * devicePixelRatio, 3 * devicePixelRatio]);
        ctx.beginPath();
        ctx.moveTo(x, u.bbox.top);
        ctx.lineTo(x, u.bbox.top + u.bbox.height);
        ctx.stroke();
        ctx.restore();
      },
    },
  };
}

/** A session boundary on the trace (seconds) and its health flag's severity (`boundary-flags.ts`). */
export interface BoundaryMark {
  t: number;
  severity?: BoundarySeverity;
}

/** Colour of a boundary line: mid grey (light and dark theme), or the flag's warning/failed colour. */
function boundaryColour(s: BoundarySeverity | undefined): string {
  if (s === 'failed') return OKABE_ITO.vermillion;
  if (s === 'warning') return OKABE_ITO.orange;
  return '#8a8a8a';
}

/**
 * Thin solid lines at the session boundaries of a multi-session run; a
 * boundary flagged warning or failed is drawn thicker in its colour with a
 * "!" at the top.
 */
function boundaryPlugin(marks: () => readonly BoundaryMark[]): uPlot.Plugin {
  return {
    hooks: {
      draw: (u) => {
        const ms = marks();
        if (ms.length === 0) return;
        const ctx = u.ctx;
        ctx.save();
        for (const m of ms) {
          const x = u.valToPos(m.t, 'x', true);
          if (x < u.bbox.left || x > u.bbox.left + u.bbox.width) continue;
          const flagged = m.severity === 'warning' || m.severity === 'failed';
          ctx.strokeStyle = boundaryColour(m.severity);
          ctx.lineWidth = (flagged ? 2 : 1) * devicePixelRatio;
          ctx.beginPath();
          ctx.moveTo(x, u.bbox.top);
          ctx.lineTo(x, u.bbox.top + u.bbox.height);
          ctx.stroke();
          if (flagged) {
            ctx.fillStyle = boundaryColour(m.severity);
            ctx.font = `bold ${11 * devicePixelRatio}px sans-serif`;
            ctx.textBaseline = 'top';
            ctx.fillText('!', x + 3 * devicePixelRatio, u.bbox.top + 2 * devicePixelRatio);
          }
        }
        ctx.restore();
      },
    },
  };
}

const SERIES: uPlot.Series[] = [{}, { label: 'trace', stroke: OKABE_ITO.vermillion, width: 1.25 }];

/**
 * The selected cell's whole trace in the CaTune/CaDecon viewer: an overview
 * of everything processed so far (click or drag to move, drag the edges to
 * resize) above a zoom window (drag to pan, Ctrl/Cmd + wheel to zoom). While
 * the window touches the newest frame it follows the live stream.
 */
export function CellTraceViewer(props: {
  cells: CellStore;
  id: number;
  fps: number;
  /** Frame of the footprint version picked on the slider (marked on the trace). */
  markerFrame?: number | null;
  /** First frames of sessions 2.. of a multi-session run (marked on the trace). */
  boundaries?: readonly number[];
  /** Their health flags (Joint runs): a warning or failed boundary is marked in its colour. */
  boundaryFlags?: readonly { frame: number; severity: BoundarySeverity }[];
  /**
   * The zoom plot is sized by its width (the shared aspect rule) instead of a
   * share of the window's height.
   */
  fill?: boolean;
}): JSX.Element {
  const fs = () => props.fps;
  const [height, setHeight] = createSignal(zoomHeight());
  /** `fill`: the zoom plot's height follows the box's width by the shared aspect rule. */
  const fillBox = (box: HTMLDivElement) => {
    if (typeof ResizeObserver === 'undefined') return;
    setHeight(plotHeight(box.clientWidth));
    const ro = new ResizeObserver(() => {
      // Hidden (a tab not shown): keep the last height.
      if (box.clientWidth > 0) setHeight(plotHeight(box.clientWidth));
    });
    ro.observe(box);
    onCleanup(() => ro.disconnect());
  };
  // eslint-disable-next-line solid/reactivity -- the mode is fixed per mount
  if (!props.fill) {
    const onResize = () => setHeight(zoomHeight());
    window.addEventListener('resize', onResize);
    onCleanup(() => window.removeEventListener('resize', onResize));
  }
  const markerTime = () =>
    props.markerFrame === null || props.markerFrame === undefined ? null : props.markerFrame / fs();
  // Read when the chart draws (a data change redraws it, see `data`).
  /* eslint-disable solid/reactivity */
  const plugins = [
    markerPlugin(markerTime),
    boundaryPlugin(() =>
      (props.boundaries ?? []).map((f) => ({
        t: f / fs(),
        severity: props.boundaryFlags?.find((b) => b.frame === f)?.severity,
      })),
    ),
  ];
  /* eslint-enable solid/reactivity */
  const frames = () => props.cells.frame();
  const duration = () => frames() / fs();

  const span = createMemo(() => {
    props.cells.tick();
    return props.cells.history().span(props.id);
  });
  const envelope = createMemo(() => {
    props.cells.tick();
    const e = props.cells.history().overview(props.id);
    return { duration: duration(), x: e.frames.map((f) => f / fs()), y: e.values };
  });

  const [width, setWidth] = createSignal(DEFAULT_WINDOW_S);
  const [start, setStart] = createSignal(0);
  const [follow, setFollow] = createSignal(true);

  // A new cell: back to the newest frames, keeping the chosen width.
  createEffect(
    on(
      () => props.id,
      () => setFollow(true),
    ),
  );

  const view = createMemo((): [number, number] => {
    const d = duration();
    const w = Math.min(width(), d);
    if (follow()) return [Math.max(0, d - w), d];
    const s = Math.min(start(), Math.max(0, d - w));
    return [s, s + w];
  });

  function onZoom(s: number, e: number): void {
    setStart(s);
    setWidth(Math.max(1 / fs(), e - s));
    // Touching the live end keeps following new frames.
    setFollow(e >= duration() - 1 / fs());
  }

  // A picked footprint version outside the window: centre the window on it.
  createEffect(
    on(markerTime, (t) => {
      if (t === null) return;
      const [s, e] = view();
      if (t >= s && t <= e) return;
      const w = e - s;
      setFollow(false);
      setStart(Math.max(0, t - w / 2));
    }),
  );

  const data = createMemo((): uPlot.AlignedData => {
    markerTime(); // new data redraws the chart, and with it the marker
    props.cells.tick();
    const [s, e] = view();
    const retained = span();
    const i0 = Math.max(retained?.first ?? 0, Math.ceil(s * fs()));
    const i1 = Math.max(i0, Math.min(retained?.end ?? 0, Math.floor(e * fs()) + 1));
    const y = props.cells.history().range(props.id, i0, i1);
    const x = new Float64Array(y.length);
    for (let i = 0; i < y.length; i++) x[i] = (i0 + i) / fs();
    const [dx, dy] = downsampleMinMax(x, y, ZOOM_BUCKETS);
    // Null endpoints preserve the requested time range even without detail.
    return [
      [s, ...dx, e],
      [null, ...dy, null],
    ];
  });

  const frameRange = () => {
    const [s, e] = view();
    return `frames ${Math.floor(s * fs()).toLocaleString()} to ${Math.ceil(e * fs()).toLocaleString()}`;
  };

  return (
    <div
      class="cala-trace-viewer"
      classList={{ 'cala-trace-viewer--fill': props.fill }}
      data-testid="cell-trace"
    >
      <div class="cala-trace-head">
        <h3 class="panel-label">Trace</h3>
        <span class="cala-muted" data-testid="cell-trace-range">
          {frameRange()}
          <Show when={follow() && !props.cells.saved()}> &middot; live</Show>
          <Show when={markerTime() !== null}>
            {' '}
            &middot; <span style={{ color: OKABE_ITO.blue }}>|</span> footprint version
          </Show>
        </span>
      </div>
      <Show
        when={duration() > 0}
        fallback={<p class="cala-muted">No frames solved for this cell yet.</p>}
      >
        <TraceOverview
          envelope={envelope()}
          samplingRate={fs()}
          zoomStart={view()[0]}
          zoomEnd={view()[1]}
          onZoomChange={onZoom}
        />
        <p class="cala-muted cala-hint" data-testid="cell-trace-history-note">
          Whole-session overview: min/max envelope.{' '}
          <Show when={span()} fallback="Full-resolution samples are unavailable for this cell.">
            {(s) => (
              <>
                Full-resolution detail retained for frames {s().first.toLocaleString()} to{' '}
                {(s().end - 1).toLocaleString()}; earlier regions have overview only.
              </>
            )}
          </Show>
        </p>
        <div
          ref={(el) => props.fill && fillBox(el)}
          class="cala-trace-zoom"
          style={{ height: `${height()}px` }}
        >
          <Show when={height()} keyed>
            {(h) => (
              <ZoomWindow
                data={data}
                series={() => SERIES}
                totalDuration={duration()}
                startTime={view()[0]}
                endTime={view()[1]}
                height={h}
                syncKey="cala-cell"
                onZoomChange={onZoom}
                hideYValues={false}
                plugins={plugins}
              />
            )}
          </Show>
        </div>
      </Show>
      <p class="cala-muted cala-hint">
        Drag the trace to pan, Ctrl/Cmd + wheel to zoom; click or drag the overview to move.
      </p>
    </div>
  );
}
