import { createEffect, createMemo, createSignal, on, onCleanup, Show, type JSX } from 'solid-js';
import { OKABE_ITO, TraceOverview, ZoomWindow } from '@calab/ui/chart';
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
}): JSX.Element {
  const fs = () => props.fps;
  const [height, setHeight] = createSignal(zoomHeight());
  const onResize = () => setHeight(zoomHeight());
  window.addEventListener('resize', onResize);
  onCleanup(() => window.removeEventListener('resize', onResize));
  const markerTime = () =>
    props.markerFrame === null || props.markerFrame === undefined ? null : props.markerFrame / fs();
  // Read when the chart draws (a data change redraws it, see `data`).
  // eslint-disable-next-line solid/reactivity
  const plugins = [markerPlugin(markerTime)];
  const frames = () => props.cells.frame();
  const duration = () => frames() / fs();

  // The trace on stream frames [0, frames): NaN before the cell was found.
  const trace = createMemo(() => {
    props.cells.tick();
    return props.cells.history().dense(props.id, frames());
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
    const t = trace();
    const [s, e] = view();
    const i0 = Math.max(0, Math.floor(s * fs()));
    const i1 = Math.min(t.length, Math.ceil(e * fs()) + 1);
    const y = t.subarray(i0, i1);
    const x = new Float64Array(y.length);
    for (let i = 0; i < y.length; i++) x[i] = (i0 + i) / fs();
    const [dx, dy] = downsampleMinMax(x, y, ZOOM_BUCKETS);
    return [dx, dy];
  });

  const frameRange = () => {
    const [s, e] = view();
    return `frames ${Math.floor(s * fs()).toLocaleString()} to ${Math.ceil(e * fs()).toLocaleString()}`;
  };

  return (
    <div class="cala-trace-viewer" data-testid="cell-trace">
      <div class="cala-trace-head">
        <h3 class="panel-label">Trace</h3>
        <span class="cala-muted" data-testid="cell-trace-range">
          {frameRange()}
          <Show when={follow()}> &middot; live</Show>
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
          trace={trace()}
          samplingRate={fs()}
          zoomStart={view()[0]}
          zoomEnd={view()[1]}
          onZoomChange={onZoom}
        />
        <div class="cala-trace-zoom" style={{ height: `${height()}px` }}>
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
