import { createEffect, createMemo, Show, type JSX } from 'solid-js';
import { DashboardPanel } from '@calab/ui';
import { OKABE_ITO, TracePanel, viridisRGB } from '@calab/ui/chart';
import type uPlot from 'uplot';
import { renderOverlay, pickCell, type Rgb } from '../lib/cell-overlay.ts';
import { NEW_CELL_FRAMES, summarize, type CellStore, type Summary } from '../lib/cell-store.ts';
import { displayRange, grayToImageData, toGray8, type DisplayRange } from '../lib/frame-display.ts';
import type { PipelineStore } from '../lib/pipeline-store.ts';
import type { PreviewImage } from '../lib/preview.ts';

const NEW_COLOR: Rgb = [0xf0, 0xe4, 0x42]; // Okabe-Ito yellow
const RANGE_SMOOTHING = 0.3;

/** Outline colour by when the cell was found: early blue to late green (viridis .2-.7). */
function foundColor(firstSeen: number | undefined, frame: number): Rgb {
  const t = firstSeen === undefined || frame <= 0 ? 1 : firstSeen / frame;
  return viridisRGB(0.2 + 0.5 * Math.min(1, Math.max(0, t)));
}

function fmt(s: Summary): string {
  if (s.n === 0) return 'n/a';
  return `${s.mean.toFixed(1)} / ${s.p99.toFixed(1)} / ${s.max.toFixed(1)} ms (${s.n} batches)`;
}

/** The corrected video with the cell outlines on top; click a cell to select it. */
function CellsView(props: {
  image: PreviewImage | null;
  cells: CellStore;
  width: number;
  height: number;
}): JSX.Element {
  let video!: HTMLCanvasElement;
  let overlay!: HTMLCanvasElement;
  let range: DisplayRange | null = null;

  createEffect(() => {
    const img = props.image;
    const ctx = video.getContext('2d');
    if (!img || !ctx) return;
    const r = displayRange(img.data, 0, true);
    range = range
      ? {
          lo: range.lo + RANGE_SMOOTHING * (r.lo - range.lo),
          hi: range.hi + RANGE_SMOOTHING * (r.hi - range.hi),
        }
      : r;
    if (video.width !== img.width) video.width = img.width;
    if (video.height !== img.height) video.height = img.height;
    ctx.putImageData(grayToImageData(toGray8(img.data, 0, range), img.width, img.height), 0, 0);
  });

  // Redraw on a new library, a new selection, or every 50 frames (new-cell fade).
  const fadeTick = createMemo(() => Math.floor(props.cells.frame() / 50));
  createEffect(() => {
    const g = props.cells.geometry();
    const selected = props.cells.selected();
    fadeTick();
    const ctx = overlay.getContext('2d');
    if (!ctx) return;
    if (overlay.width !== props.width) overlay.width = props.width;
    if (overlay.height !== props.height) overlay.height = props.height;
    if (!g) {
      ctx.clearRect(0, 0, overlay.width, overlay.height);
      return;
    }
    const frame = props.cells.frame();
    const rgba = renderOverlay(g, {
      selected,
      color: (id) =>
        props.cells.age(id) < NEW_CELL_FRAMES
          ? NEW_COLOR
          : foundColor(props.cells.firstSeen(id), frame),
      fill: (id) => {
        const age = props.cells.age(id);
        return age < NEW_CELL_FRAMES ? 0.3 * (1 - age / NEW_CELL_FRAMES) + 0.08 : 0;
      },
    });
    ctx.putImageData(
      new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, g.width, g.height),
      0,
      0,
    );
  });

  function onClick(e: MouseEvent): void {
    const g = props.cells.geometry();
    if (!g) return;
    const rect = overlay.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * g.width;
    const y = ((e.clientY - rect.top) / rect.height) * g.height;
    props.cells.select(pickCell(g, x, y));
  }

  return (
    <div
      class="cala-cells-stage"
      style={{ 'aspect-ratio': `${props.width} / ${props.height}` }}
      data-testid="cells-view"
    >
      <canvas ref={video} class="cala-cells-layer" aria-label="Motion-corrected video" />
      <canvas
        ref={overlay}
        class="cala-cells-layer cala-cells-overlay"
        aria-label="Cell outlines (click a cell)"
        data-testid="cells-overlay"
        onClick={onClick}
      />
    </div>
  );
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
        <h3 class="panel-label">Cell {props.id}</h3>
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
      <TracePanel
        data={data}
        series={TRACE_SERIES}
        height={150}
        syncKey="cala-cell"
        xLabel="Frame"
      />
    </div>
  );
}

/** Live cell discovery: outlines on the video, the clicked cell, and growth metrics. */
export function CellsPanel(props: {
  store: PipelineStore;
  cells: CellStore;
  width: number;
  height: number;
}): JSX.Element {
  const c = () => props.cells;
  const s = () => props.store;

  const counts = createMemo((): [number[], ...number[][]] => {
    c().tick();
    const m = c().metrics();
    return [m.frame.slice(), m.cells.slice(), m.working.slice() as number[]];
  });
  const lag = createMemo((): [number[], ...number[][]] => {
    c().tick();
    const m = c().metrics();
    return [m.frame.slice(), m.lag.slice() as number[]];
  });
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
  const lagNow = () => {
    const m = c().metrics();
    c().tick();
    const v = m.lag[m.lag.length - 1];
    return v === null || v === undefined ? null : v;
  };

  return (
    <DashboardPanel id="cells" variant="data">
      <div class="cala-pipeline-head">
        <h2 class="panel-label">Cells (live discovery)</h2>
        <span class="cala-readout" data-testid="cells-readout">
          {c().library()?.ids.length ?? 0} cells &middot; library v{c().version()} &middot; lag{' '}
          {lagNow() ?? 'n/a'} frames
        </span>
      </div>

      <div class="cala-pair">
        <figure class="cala-pane">
          <CellsView
            image={s().previews()?.output ?? null}
            cells={c()}
            width={props.width}
            height={props.height}
          />
          <figcaption class="cala-legend">
            outline colour: when found
            <span
              class="cala-legend__swatch"
              style={{ background: `rgb(${viridisRGB(0.2).join(',')})` }}
            />
            early
            <span
              class="cala-legend__swatch"
              style={{ background: `rgb(${viridisRGB(0.7).join(',')})` }}
            />
            late
            <span class="cala-legend__swatch" style={{ background: OKABE_ITO.yellow }} />
            new (last {NEW_CELL_FRAMES} frames)
          </figcaption>
        </figure>
        <div class="cala-pane">
          <Show
            when={c().selected()}
            fallback={
              <p class="cala-muted">Click a cell outline to see its trace and footprint.</p>
            }
          >
            {(id) => <SelectedCell cells={c()} id={id()} />}
          </Show>
        </div>
      </div>

      <div class="cala-controls">
        <label class="cala-check">
          <input
            type="checkbox"
            checked={s().discover()}
            onChange={(e) => s().setDiscover(e.currentTarget.checked)}
          />
          Discover cells
        </label>
        <span class="cala-muted" data-testid="cells-counters">
          <Show when={c().status()} fallback="slow loop starts after frame 50">
            {(st) => (
              <>
                working set {st().cells} &middot; adds {st().counters.adds}, merges{' '}
                {st().counters.merges}, refines {st().counters.refines}, rejects{' '}
                {st().counters.rejects} &middot; versions {changes().versions} (+{changes().added} /
                -{changes().removed} cells) &middot; dropped {dropPct().toFixed(0)}% of frames
                &middot; reservoir {(st().reservoirBytes / 1048576).toFixed(0)} MB
              </>
            )}
          </Show>
        </span>
      </div>

      <Show when={c().error()}>
        {(message) => (
          <div class="error-card" role="alert">
            <span>Cell discovery stopped: {message()}</span>
          </div>
        )}
      </Show>

      <div class="cala-motion-trace" data-testid="cells-metrics">
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
          height={170}
          syncKey="cala-cells"
          xLabel="Frame"
        />
      </div>
      <div class="cala-motion-trace" data-testid="lag-metrics">
        <div class="cala-trace-head">
          <h3 class="panel-label">Slow-loop lag (frames behind the fast loop)</h3>
        </div>
        <TracePanel
          data={lag}
          series={LAG_SERIES}
          height={130}
          syncKey="cala-cells"
          xLabel="Frame"
        />
      </div>
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
    </DashboardPanel>
  );
}
