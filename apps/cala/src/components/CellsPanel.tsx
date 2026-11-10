import { createEffect, createMemo, createSignal, on, Show, type JSX } from 'solid-js';
import { DashboardPanel } from '@calab/ui';
import { OKABE_ITO, TracePanel, viridisRGB } from '@calab/ui/chart';
import type uPlot from 'uplot';
import { summarize, type CellStore, type Summary } from '../lib/cell-store.ts';
import type { PipelineStore } from '../lib/pipeline-store.ts';
import { CellTraceViewer } from './CellTraceViewer.tsx';
import { CellQcSummary, DemixView } from './CellQcView.tsx';

function fmt(s: Summary): string {
  if (s.n === 0) return 'n/a';
  return `${s.mean.toFixed(1)} / ${s.p99.toFixed(1)} / ${s.max.toFixed(1)} ms (${s.n} batches)`;
}

/**
 * The selected cell's footprint (unfiltered, viridis, its own peak = 1) and how
 * it changed: one snapshot per library version that changed it, drawn in the
 * union of their crops so successive versions line up. The slider steps
 * through them; it stays on the newest while it is there.
 */
function FootprintEvolution(props: {
  cells: CellStore;
  id: number;
  /** The frame of the snapshot shown, for the marker on the trace. */
  onFrame?: (frame: number | null) => void;
}): JSX.Element {
  let canvas!: HTMLCanvasElement;
  const snaps = createMemo(() => {
    props.cells.library();
    return [...props.cells.footprints().get(props.id)];
  });
  const [picked, setPicked] = createSignal<number | null>(null);
  // null = follow the newest snapshot.
  createEffect(
    on(
      () => props.id,
      () => setPicked(null),
    ),
  );
  const index = () => {
    const n = snaps().length;
    const p = picked();
    return p === null ? n - 1 : Math.min(p, n - 1);
  };
  const current = () => snaps()[index()];
  // Mark the version on the trace only while an older one is picked.
  createEffect(() => props.onFrame?.(picked() === null ? null : (current()?.frame ?? null)));

  createEffect(() => {
    const all = snaps();
    const snap = current();
    const ctx = canvas.getContext('2d');
    if (!snap || !ctx) return;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = 0;
    let y1 = 0;
    for (const s of all) {
      x0 = Math.min(x0, s.x0);
      y0 = Math.min(y0, s.y0);
      x1 = Math.max(x1, s.x0 + s.w);
      y1 = Math.max(y1, s.y0 + s.h);
    }
    const w = x1 - x0;
    const h = y1 - y0;
    if (w <= 0 || h <= 0) return;
    canvas.width = w;
    canvas.height = h;
    const img = ctx.createImageData(w, h);
    const lut = Array.from({ length: 256 }, (_, v) => viridisRGB(v / 255));
    const bg = lut[0];
    for (let i = 0; i < w * h; i++) img.data.set([bg[0], bg[1], bg[2], 255], i * 4);
    for (let y = 0; y < snap.h; y++) {
      for (let x = 0; x < snap.w; x++) {
        const c = lut[snap.data[y * snap.w + x]];
        img.data.set([c[0], c[1], c[2], 255], ((snap.y0 - y0 + y) * w + snap.x0 - x0 + x) * 4);
      }
    }
    ctx.putImageData(img, 0, 0);
  });

  return (
    <div class="cala-footprint">
      <canvas
        ref={canvas}
        class="cala-footprint-zoom"
        aria-label="Footprint of the selected cell"
        data-testid="footprint-zoom"
      />
      <Show when={snaps().length > 0}>
        <input
          type="range"
          class="cala-footprint__slider"
          aria-label="Footprint version"
          min="0"
          max={Math.max(0, snaps().length - 1)}
          step="1"
          value={index()}
          disabled={snaps().length < 2}
          onInput={(e) => {
            const v = Number(e.currentTarget.value);
            setPicked(v >= snaps().length - 1 ? null : v);
          }}
        />
        <span class="cala-muted cala-footprint__readout" data-testid="footprint-version">
          v{current()?.version} &middot; frame {current()?.frame.toLocaleString()} ({index() + 1} /{' '}
          {snaps().length})
        </span>
      </Show>
    </div>
  );
}

const COUNT_SERIES: uPlot.Series[] = [
  {},
  { label: 'fast-loop library', stroke: OKABE_ITO.blue, width: 1.5 },
  { label: 'slow-loop working set', stroke: OKABE_ITO.bluishGreen, width: 1, dash: [4, 3] },
];
const LAG_SERIES: uPlot.Series[] = [
  {},
  { label: 'lag (frames)', stroke: OKABE_ITO.orange, width: 1.25 },
];

function SelectedCell(props: { cells: CellStore; id: number; fps: number }): JSX.Element {
  const c = () => props.cells;
  const [view, setView] = createSignal<'trace' | 'demix'>('trace');
  const [markerFrame, setMarkerFrame] = createSignal<number | null>(null);
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
        <FootprintEvolution cells={c()} id={props.id} onFrame={setMarkerFrame} />
        <div class="cala-muted cala-selected__facts">
          <Show when={info()} fallback={<div>No longer in the library (merged or removed).</div>}>
            {(i) => (
              <div>
                centre ({i().x.toFixed(0)}, {i().y.toFixed(0)}) px, support r {i().r.toFixed(1)} px
              </div>
            )}
          </Show>
          <div>found after frame {c().firstSeen(props.id)?.toLocaleString() ?? '?'}</div>
          <Show when={inLibrary()}>
            <div>
              footprint: unfiltered, its own peak = 1; the slider steps through its versions
            </div>
          </Show>
        </div>
      </div>
      <CellQcSummary cells={c()} id={props.id} />
      <div class="cala-subtabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={view() === 'trace'}
          class="cala-tabs__tab"
          classList={{ 'cala-tabs__tab--active': view() === 'trace' }}
          onClick={() => setView('trace')}
        >
          Trace
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view() === 'demix'}
          class="cala-tabs__tab"
          classList={{ 'cala-tabs__tab--active': view() === 'demix' }}
          onClick={() => setView('demix')}
          data-testid="demix-tab"
        >
          Demixing
        </button>
      </div>
      <Show
        when={view() === 'demix'}
        fallback={
          <CellTraceViewer cells={c()} id={props.id} fps={props.fps} markerFrame={markerFrame()} />
        }
      >
        <DemixView cells={c()} id={props.id} />
      </Show>
    </div>
  );
}

/** The clicked cell: footprint, facts and trace (right-hand column). */
export function SelectedCellPanel(props: { cells: CellStore; fps: number }): JSX.Element {
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
        {(id) => <SelectedCell cells={props.cells} id={id()} fps={props.fps} />}
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
      solveQc: summarize(t.solveQc),
      solveNoQc: summarize(t.solveNoQc),
      qcBuild: summarize(t.qcBuildMs),
      slowStep: summarize(c().slowTiming().stepMs),
      slowBatch: summarize(c().slowTiming().batchMs),
    };
  });
  return (
    <div class="cala-timing">
      <p class="cala-muted" data-testid="pipeline-stages">
        Pipeline ms/frame: read {s().stageMs().readMs.toFixed(1)}, preprocess{' '}
        {s().stageMs().preprocessMs.toFixed(1)}, motion {s().stageMs().motionMs.toFixed(1)}
        <Show when={s().stageBusy().length > 0}>
          {' '}
          | pipelined stage busy ms/frame: frame+preprocess {s().stageBusy()[0].toFixed(1)}, motion{' '}
          {s().stageBusy()[1].toFixed(1)}, trace {s().stageBusy()[2].toFixed(1)};{' '}
          {s().fps().toFixed(1)} fps
        </Show>
      </p>
      <p class="cala-muted" data-testid="fast-timing">
        Fast loop per frame (mean / p99 / max), discovery on: {fmt(timing().on)}; off:{' '}
        {fmt(timing().off)}. Trace solve per frame, on: {fmt(timing().solveOn)}; off:{' '}
        {fmt(timing().solveOff)}.
      </p>
      <p class="cala-muted" data-testid="qc-timing">
        Trace solve per frame with online QC: {fmt(timing().solveQc)}; without:{' '}
        {fmt(timing().solveNoQc)}. QC snapshot (about once a second): {fmt(timing().qcBuild)}.
        <Show when={timing().slowBatch.n > 0}>
          {' '}
          Slow loop per batch: {fmt(timing().slowBatch)}; longest step per batch:{' '}
          {fmt(timing().slowStep)}.
        </Show>
        <Show when={(c().status()?.visitWorkers ?? 0) > 0 ? c().status() : undefined}>
          {(st) => (
            <span data-testid="visit-timing">
              {' '}
              Tile visits on {st().visitWorkers} workers: {st().jobs} so far, {st().jobsInFlight}{' '}
              out now, {st().visitMs.toFixed(0)} ms each (latest).
            </span>
          )}
        </Show>
      </p>
    </div>
  );
}
