import { createEffect, createMemo, Show, type JSX } from 'solid-js';
import { DashboardPanel } from '@calab/ui';
import { OKABE_ITO, TracePanel, viridisRGB } from '@calab/ui/chart';
import type uPlot from 'uplot';
import { summarize, type CellStore, type Summary } from '../lib/cell-store.ts';
import type { PipelineStore } from '../lib/pipeline-store.ts';

function fmt(s: Summary): string {
  if (s.n === 0) return 'n/a';
  return `${s.mean.toFixed(1)} / ${s.p99.toFixed(1)} / ${s.max.toFixed(1)} ms (${s.n} batches)`;
}

const ZOOM_PAD = 6;

/** The selected cell's unfiltered footprint, cropped to its support, viridis. */
function FootprintZoom(props: { cells: CellStore; id: number }): JSX.Element {
  let canvas!: HTMLCanvasElement;
  createEffect(() => {
    const view = props.cells.library();
    const ctx = canvas.getContext('2d');
    if (!view || !ctx) return;
    const slot = view.ids.indexOf(props.id);
    if (slot < 0) return;
    const a = view.starts[slot];
    const b = view.starts[slot + 1];
    let y0 = view.height;
    let x0 = view.width;
    let y1 = 0;
    let x1 = 0;
    let peak = 0;
    for (let k = a; k < b; k++) {
      const p = view.pixels[k];
      const y = Math.floor(p / view.width);
      const x = p - y * view.width;
      y0 = Math.min(y0, y);
      x0 = Math.min(x0, x);
      y1 = Math.max(y1, y + 1);
      x1 = Math.max(x1, x + 1);
      peak = Math.max(peak, view.values[k]);
    }
    if (b <= a) return;
    y0 = Math.max(0, y0 - ZOOM_PAD);
    x0 = Math.max(0, x0 - ZOOM_PAD);
    y1 = Math.min(view.height, y1 + ZOOM_PAD);
    x1 = Math.min(view.width, x1 + ZOOM_PAD);
    const w = x1 - x0;
    const h = y1 - y0;
    canvas.width = w;
    canvas.height = h;
    const img = ctx.createImageData(w, h);
    const bg = viridisRGB(0);
    for (let i = 0; i < w * h; i++) {
      img.data.set([bg[0], bg[1], bg[2], 255], i * 4);
    }
    for (let k = a; k < b; k++) {
      const p = view.pixels[k];
      const y = Math.floor(p / view.width) - y0;
      const x = (p % view.width) - x0;
      const c = viridisRGB(peak > 0 ? view.values[k] / peak : 0);
      img.data.set([c[0], c[1], c[2], 255], (y * w + x) * 4);
    }
    ctx.putImageData(img, 0, 0);
  });
  return (
    <canvas
      ref={canvas}
      class="cala-footprint-zoom"
      aria-label="Footprint of the selected cell"
      data-testid="footprint-zoom"
    />
  );
}

const TRACE_SERIES: uPlot.Series[] = [
  {},
  { label: 'trace', stroke: OKABE_ITO.vermillion, width: 1.25 },
];
const COUNT_SERIES: uPlot.Series[] = [
  {},
  { label: 'fast-loop library', stroke: OKABE_ITO.blue, width: 1.5 },
  { label: 'slow-loop working set', stroke: OKABE_ITO.bluishGreen, width: 1, dash: [4, 3] },
];
const LAG_SERIES: uPlot.Series[] = [
  {},
  { label: 'lag (frames)', stroke: OKABE_ITO.orange, width: 1.25 },
];

function SelectedCell(props: { cells: CellStore; id: number }): JSX.Element {
  const c = () => props.cells;
  const data = createMemo((): [number[], ...number[][]] => {
    c().tick();
    const t = c().history().get(props.id);
    return [t.frames, t.values];
  });
  const inLibrary = () => c().library()?.ids.includes(props.id) ?? false;
  const info = () => {
    const view = c().library();
    const slot = view ? view.ids.indexOf(props.id) : -1;
    if (!view || slot < 0) return null;
    return {
      y: view.centers[2 * slot],
      x: view.centers[2 * slot + 1],
      r: view.radii[slot],
    };
  };
  return (
    <div class="cala-selected" data-testid="selected-cell">
      <div class="cala-trace-head">
        <h2 class="panel-label">Cell {props.id}</h2>
        <button type="button" class="btn-secondary btn-small" onClick={() => c().select(null)}>
          Clear
        </button>
      </div>
      <div class="cala-selected__body">
        <FootprintZoom cells={c()} id={props.id} />
        <div class="cala-muted">
          <Show when={info()} fallback={<div>No longer in the library (merged or removed).</div>}>
            {(i) => (
              <div>
                centre ({i().x.toFixed(0)}, {i().y.toFixed(0)}) px, support r {i().r.toFixed(1)} px
              </div>
            )}
          </Show>
          <div>found after frame {c().firstSeen(props.id)?.toLocaleString() ?? '?'}</div>
          <Show when={inLibrary()}>
            <div>footprint: unfiltered, its own peak = 1</div>
          </Show>
        </div>
      </div>
      <h3 class="panel-label">Trace</h3>
      <TracePanel
        data={data}
        series={TRACE_SERIES}
        height={200}
        syncKey="cala-cell"
        xLabel="Frame"
      />
    </div>
  );
}

/** The clicked cell: footprint, facts and trace (right-hand column). */
export function SelectedCellPanel(props: { cells: CellStore }): JSX.Element {
  return (
    <DashboardPanel id="cell" variant="data" class="cala-cell-panel">
      <Show
        when={props.cells.selected()}
        fallback={
          <>
            <h2 class="panel-label">Selected cell</h2>
            <p class="cala-muted">Click a cell outline to see its footprint and trace.</p>
          </>
        }
      >
        {(id) => <SelectedCell cells={props.cells} id={id()} />}
      </Show>
    </DashboardPanel>
  );
}

/** Library size against frames read, and the slow loop's counters. */
export function CellCountPlot(props: { cells: CellStore }): JSX.Element {
  const c = () => props.cells;
  const counts = createMemo((): [number[], ...number[][]] => {
    c().tick();
    const m = c().metrics();
    return [m.frame.slice(), m.cells.slice(), m.working.slice() as number[]];
  });
  const changes = () => {
    const ev = c().events();
    let added = 0;
    let removed = 0;
    for (const e of ev) {
      added += e.added;
      removed += e.removed;
    }
    return { added, removed, versions: ev.length };
  };
  const dropPct = () => {
    const b = c().batch();
    if (!b) return 0;
    const all = b.forwardedFrames + b.droppedFrames;
    return all > 0 ? (100 * b.droppedFrames) / all : 0;
  };
  return (
    <div data-testid="cells-metrics">
      <div class="cala-trace-head">
        <h3 class="panel-label">Cells vs frames read</h3>
        <span class="cala-legend">
          <span class="cala-legend__swatch" style={{ background: OKABE_ITO.blue }} />
          fast-loop library
          <span class="cala-legend__swatch" style={{ background: OKABE_ITO.bluishGreen }} />
          slow-loop working set
        </span>
      </div>
      <TracePanel
        data={counts}
        series={COUNT_SERIES}
        height={130}
        syncKey="cala-cells"
        xLabel="Frame"
      />
      <p class="cala-muted cala-tab-note" data-testid="cells-counters">
        <Show when={c().status()} fallback="The slow loop starts after frame 50.">
          {(st) => (
            <>
              working set {st().cells} &middot; adds {st().counters.adds}, merges{' '}
              {st().counters.merges}, refines {st().counters.refines}, rejects{' '}
              {st().counters.rejects} &middot; versions {changes().versions} (+{changes().added} / -
              {changes().removed} cells) &middot; dropped {dropPct().toFixed(0)}% of frames &middot;
              reservoir {(st().reservoirBytes / 1048576).toFixed(0)} MB
            </>
          )}
        </Show>
      </p>
    </div>
  );
}

/** How far the slow loop is behind the fast loop. */
export function LagPlot(props: { cells: CellStore }): JSX.Element {
  const lag = createMemo((): [number[], ...number[][]] => {
    props.cells.tick();
    const m = props.cells.metrics();
    return [m.frame.slice(), m.lag.slice() as number[]];
  });
  return (
    <div data-testid="lag-metrics">
      <div class="cala-trace-head">
        <h3 class="panel-label">Slow-loop lag (frames behind the fast loop)</h3>
      </div>
      <TracePanel data={lag} series={LAG_SERIES} height={130} syncKey="cala-cells" xLabel="Frame" />
    </div>
  );
}

/** Per-stage and per-loop timing as text. */
export function TimingText(props: { store: PipelineStore; cells: CellStore }): JSX.Element {
  const s = () => props.store;
  const c = () => props.cells;
  const timing = createMemo(() => {
    c().tick();
    const t = c().timing();
    return {
      on: summarize(t.on),
      off: summarize(t.off),
      solveOn: summarize(t.solveOn),
      solveOff: summarize(t.solveOff),
      slowStep: summarize(c().slowTiming().stepMs),
      slowBatch: summarize(c().slowTiming().batchMs),
    };
  });
  return (
    <div class="cala-timing">
      <p class="cala-muted" data-testid="pipeline-stages">
        Pipeline ms/frame: read {s().stageMs().readMs.toFixed(1)}, preprocess{' '}
        {s().stageMs().preprocessMs.toFixed(1)}, motion {s().stageMs().motionMs.toFixed(1)}
      </p>
      <p class="cala-muted" data-testid="fast-timing">
        Fast loop per frame (mean / p99 / max), discovery on: {fmt(timing().on)}; off:{' '}
        {fmt(timing().off)}. Trace solve per frame, on: {fmt(timing().solveOn)}; off:{' '}
        {fmt(timing().solveOff)}.
        <Show when={timing().slowBatch.n > 0}>
          {' '}
          Slow loop per batch: {fmt(timing().slowBatch)}; longest step per batch:{' '}
          {fmt(timing().slowStep)}.
        </Show>
      </p>
    </div>
  );
}
