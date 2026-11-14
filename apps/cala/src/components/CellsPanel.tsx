import { createEffect, createMemo, createSignal, on, Show, type JSX } from 'solid-js';
import type { BoundarySeverity } from '../lib/boundary-flags.ts';
import { SegmentedControl, Tabs } from '@calab/ui';
import { viridisRGB } from '@calab/ui/chart';
import { summarize, type CellStore, type Summary } from '../lib/cell-store.ts';
import type { PipelineStore } from '../lib/pipeline-store.ts';
import { CellTraceViewer } from './CellTraceViewer.tsx';
import { CellQcSummary, DemixView } from './CellQcView.tsx';
import { SidePanel } from './SidePanel.tsx';

function fmt(s: Summary): string {
  if (s.n === 0) return 'n/a';
  return `${s.mean.toFixed(1)} / ${s.p99.toFixed(1)} / ${s.max.toFixed(1)} ms (${s.n} batches)`;
}

export type FootprintScale = 'linear' | 'log';

/** Side of the footprint view, CSS px (the crop is drawn at an integer upscale near it). */
const FOOTPRINT_VIEW_PX = 160;
const LUT = Array.from({ length: 256 }, (_, v) => viridisRGB(v / 255));
/** Decades the log scale spans: the 8-bit snapshot's smallest step (1/255 of the peak) to the peak. */
const LOG_DECADES = Math.log10(255);

/** Colour level 0..255 of a snapshot value `q` (1..255 of the peak) on a linear or log scale. */
export function footprintLevel(q: number, log: boolean): number {
  if (q <= 0) return 0;
  if (!log) return q;
  const t = 1 + Math.log10(q / 255) / LOG_DECADES;
  return Math.max(0, Math.min(255, Math.round(255 * t)));
}

/** Stroke the boundary of `mask` (w x h) between pixels, at `k` canvas px per pixel. */
function strokeEdges(
  ctx: CanvasRenderingContext2D,
  mask: Uint8Array,
  w: number,
  h: number,
  k: number,
  color: string,
): void {
  ctx.beginPath();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      if (x === 0 || !mask[y * w + x - 1]) {
        ctx.moveTo(x * k, y * k);
        ctx.lineTo(x * k, (y + 1) * k);
      }
      if (x === w - 1 || !mask[y * w + x + 1]) {
        ctx.moveTo((x + 1) * k, y * k);
        ctx.lineTo((x + 1) * k, (y + 1) * k);
      }
      if (y === 0 || !mask[(y - 1) * w + x]) {
        ctx.moveTo(x * k, y * k);
        ctx.lineTo((x + 1) * k, y * k);
      }
      if (y === h - 1 || !mask[(y + 1) * w + x]) {
        ctx.moveTo(x * k, (y + 1) * k);
        ctx.lineTo((x + 1) * k, (y + 1) * k);
      }
    }
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, Math.min(2, k / 3));
  ctx.stroke();
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
  scale: FootprintScale;
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
    const g = props.cells.geometry();
    const log = props.scale === 'log';
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
    // Drawn at an integer upscale so the outlines fall between pixels.
    const k = Math.max(1, Math.floor(FOOTPRINT_VIEW_PX / Math.max(w, h)));
    canvas.width = w * k;
    canvas.height = h * k;
    const img = new ImageData(w, h);
    const bg = LUT[0];
    for (let i = 0; i < w * h; i++) img.data.set([bg[0], bg[1], bg[2], 255], i * 4);
    const inSupport = new Uint8Array(w * h);
    for (let y = 0; y < snap.h; y++) {
      for (let x = 0; x < snap.w; x++) {
        const q = snap.data[y * snap.w + x];
        if (q === 0) continue;
        const o = (snap.y0 - y0 + y) * w + snap.x0 - x0 + x;
        inSupport[o] = 1;
        const c = LUT[footprintLevel(q, log)];
        img.data.set([c[0], c[1], c[2], 255], o * 4);
      }
    }
    const off = new OffscreenCanvas(w, h);
    off.getContext('2d')?.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, 0, 0, w * k, h * k);
    // Neighbours (grey, their outline at the overlay's level), then this
    // cell's full support (white).
    if (g) {
      for (const shape of g.shapes) {
        if (shape.id === props.id) continue;
        if (shape.x1 <= x0 || shape.x0 >= x1 || shape.y1 <= y0 || shape.y0 >= y1) continue;
        const mask = new Uint8Array(w * h);
        for (const p of shape.inside) {
          const y = Math.floor(p / g.width) - y0;
          const x = (p % g.width) - x0;
          if (x >= 0 && y >= 0 && x < w && y < h) mask[y * w + x] = 1;
        }
        strokeEdges(ctx, mask, w, h, k, 'rgba(190, 190, 190, 0.85)');
      }
    }
    strokeEdges(ctx, inSupport, w, h, k, '#ffffff');
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

function SelectedCell(props: {
  cells: CellStore;
  id: number;
  fps: number;
  scale: FootprintScale;
  boundaries?: readonly number[];
  boundaryFlags?: readonly { frame: number; severity: BoundarySeverity }[];
}): JSX.Element {
  const c = () => props.cells;
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
      <div class="cala-selected__body">
        <FootprintEvolution
          cells={c()}
          id={props.id}
          scale={props.scale}
          onFrame={setMarkerFrame}
        />
        <div class="cala-selected__side">
          <CellQcSummary cells={c()} id={props.id} />
          <div class="cala-muted cala-selected__facts">
            <Show when={info()} fallback={<div>No longer in the library (merged or removed).</div>}>
              {(i) => (
                <div>
                  centre ({i().x.toFixed(0)}, {i().y.toFixed(0)}) px, support r {i().r.toFixed(1)}{' '}
                  px &middot; found after frame {c().firstSeen(props.id)?.toLocaleString() ?? '?'}
                </div>
              )}
            </Show>
            <Show when={inLibrary()}>
              <div>
                Footprint: full extent, its own peak = 1, no threshold ({props.scale}). White = its
                support, grey = neighbours. The slider steps through its versions.
              </div>
            </Show>
          </div>
        </div>
      </div>
      <Tabs
        class="cala-selected__tabs"
        aria-label="Cell views"
        tabs={[
          {
            id: 'trace',
            label: 'Trace',
            content: (
              <CellTraceViewer
                cells={c()}
                id={props.id}
                fps={props.fps}
                markerFrame={markerFrame()}
                boundaries={props.boundaries}
                boundaryFlags={props.boundaryFlags}
              />
            ),
          },
          {
            id: 'demix',
            label: 'Demixing',
            testid: 'demix-tab',
            content: () => <DemixView cells={c()} id={props.id} />,
          },
        ]}
        keepMounted={false}
      />
    </div>
  );
}

/** The clicked cell: footprint, facts, QC and trace (right-hand column). */
export function SelectedCellPanel(props: {
  cells: CellStore;
  fps: number;
  /** First frames of sessions 2.. of a multi-session run (marked on the trace). */
  boundaries?: readonly number[];
  /** Their health flags (Joint runs; `boundary-flags.ts`). */
  boundaryFlags?: readonly { frame: number; severity: BoundarySeverity }[];
  /** Fold to its header line (while the History tab is open); unfolds when this turns false. */
  folded?: boolean;
}): JSX.Element {
  const [scale, setScale] = createSignal<FootprintScale>('linear');
  const [open, setOpen] = createSignal(true);
  createEffect(
    on(
      () => props.folded === true,
      (f) => setOpen(!f),
    ),
  );
  /** The cell before or after the selected one, by id. */
  const step = (dir: 1 | -1) => {
    const ids = Array.from(props.cells.library()?.ids ?? []).sort((a, b) => a - b);
    if (ids.length === 0) return;
    const cur = props.cells.selected();
    if (cur === null) {
      props.cells.select(dir > 0 ? ids[0] : ids[ids.length - 1]);
      return;
    }
    const next = dir > 0 ? ids.find((i) => i > cur) : [...ids].reverse().find((i) => i < cur);
    props.cells.select(next ?? (dir > 0 ? ids[0] : ids[ids.length - 1]));
  };
  return (
    <SidePanel
      id="cell"
      open={open()}
      onToggle={setOpen}
      class="cala-cell-panel"
      title={
        <Show when={props.cells.selected()} fallback="Cell">
          {(id) => <>Cell {id()}</>}
        </Show>
      }
      actions={
        <>
          <SegmentedControl
            options={[
              { value: 'linear', label: 'linear', title: 'Linear footprint scale' },
              { value: 'log', label: 'log', title: 'Log footprint scale (2.4 decades)' },
            ]}
            value={scale()}
            onChange={setScale}
            aria-label="Footprint scale"
            size="sm"
            testid="footprint-scale"
          />
          <button
            type="button"
            class="btn-secondary btn-small"
            aria-label="Previous cell"
            title="Previous cell (by id)"
            onClick={() => step(-1)}
          >
            &#9664;
          </button>
          <button
            type="button"
            class="btn-secondary btn-small"
            aria-label="Next cell"
            title="Next cell (by id)"
            onClick={() => step(1)}
          >
            &#9654;
          </button>
          <Show when={props.cells.selected() !== null}>
            <button
              type="button"
              class="btn-secondary btn-small"
              onClick={() => props.cells.select(null)}
            >
              Clear
            </button>
          </Show>
        </>
      }
    >
      <Show
        when={props.cells.selected()}
        fallback={
          <p class="cala-muted">
            Click a cell in the field of view (or a row of the cell table) to see its footprint and
            trace.
          </p>
        }
      >
        {(id) => (
          <SelectedCell
            cells={props.cells}
            id={id()}
            fps={props.fps}
            scale={scale()}
            boundaries={props.boundaries}
            boundaryFlags={props.boundaryFlags}
          />
        )}
      </Show>
    </SidePanel>
  );
}

/** The slow loop's counters as text (kept from the old Cells tab). */
function SlowCounters(props: { cells: CellStore }): JSX.Element {
  const c = () => props.cells;
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
    <p class="cala-muted cala-tab-note" data-testid="cells-counters">
      <Show when={c().status()} fallback="The slow loop starts after frame 50.">
        {(st) => (
          <>
            working set {st().cells} &middot; adds {st().counters.adds}, merges{' '}
            {st().counters.merges}, refines {st().counters.refines}, rejects {st().counters.rejects}{' '}
            &middot; versions {changes().versions} (+{changes().added} / -{changes().removed} cells)
            &middot; dropped {dropPct().toFixed(0)}% of frames &middot; reservoir{' '}
            {(st().reservoirBytes / 1048576).toFixed(0)} MB
            <Show when={st().framesPerTile > 0}>, {st().framesPerTile} frames per tile</Show>
            <Show when={st().reservoirWarning}>
              {(w) => (
                <span class="cala-warning cala-block" data-testid="reservoir-warning">
                  {w()}
                </span>
              )}
            </Show>
          </>
        )}
      </Show>
    </p>
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
      <SlowCounters cells={props.cells} />
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
        Over recent batches (mean / p99 / max): fast loop per frame, discovery on:{' '}
        {fmt(timing().on)}; off: {fmt(timing().off)}. Trace solve per frame, on:{' '}
        {fmt(timing().solveOn)}; off: {fmt(timing().solveOff)}.
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
