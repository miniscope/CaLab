import { createEffect, createMemo, createSignal, For, on, Show, type JSX } from 'solid-js';
import type { BoundarySeverity } from '../lib/boundary-flags.ts';
import { HelpTip, Meter, SegmentedControl } from '@calab/ui';
import { viridisRGB } from '@calab/ui/chart';
import type { CellStore } from '../lib/cell-store.ts';
import { CellTraceViewer } from './CellTraceViewer.tsx';
import { CellMetricBars, CellQcSummary, DemixView } from './CellQcView.tsx';
import { QcDot } from './QcDot.tsx';
import { QcBarKey } from './QcBarKey.tsx';
import {
  metricText,
  qcMedian,
  qcMetric,
  qcStatus,
  thresholdTitle,
  topBySnr,
} from '../lib/qc-view.ts';
import { SidePanel } from './SidePanel.tsx';

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
  /** The frame the video shows (live runs with smooth playback): the trace's followed window ends there. */
  displayedFrame?: () => number | null;
}): JSX.Element {
  const c = () => props.cells;
  const [markerFrame, setMarkerFrame] = createSignal<number | null>(null);
  const [view, setView] = createSignal<'trace' | 'demix'>('trace');
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
          <div class="cala-muted cala-selected__facts" data-testid="cell-facts">
            <Show when={info()} fallback={<div>No longer in the library (merged or removed).</div>}>
              {(i) => (
                <div class="num">
                  centre ({i().x.toFixed(0)}, {i().y.toFixed(0)}) px &middot; support r{' '}
                  {i().r.toFixed(1)} px &middot; found at frame{' '}
                  {c().firstSeen(props.id)?.toLocaleString() ?? '–'}
                </div>
              )}
            </Show>
          </div>
          <Show when={inLibrary()}>
            <div class="cala-selected__help">
              <HelpTip label="About the footprint" popClass="cala-selected__help-pop">
                <p>
                  The footprint at its full extent, its own peak = 1, no threshold ({props.scale}{' '}
                  scale). White = its support, grey = its neighbours. The slider steps through its
                  versions. The bars below are its QC metrics, each on a fixed range; the tick is
                  the rule's threshold.
                </p>
              </HelpTip>
            </div>
          </Show>
        </div>
      </div>
      <CellMetricBars cells={c()} id={props.id} />
      {/* One view at a time, switched in place (the column's tabs are the only tab row). */}
      <SegmentedControl
        class="cala-selected__views"
        options={[
          { value: 'trace', label: 'Trace', testid: 'trace-tab' },
          { value: 'demix', label: 'Demixing', testid: 'demix-tab' },
        ]}
        value={view()}
        onChange={setView}
        aria-label="Cell view"
        size="sm"
        testid="cell-view"
      />
      <div class="cala-selected__view">
        <Show
          when={view() === 'demix'}
          fallback={
            <CellTraceViewer
              cells={c()}
              id={props.id}
              fps={props.fps}
              markerFrame={markerFrame()}
              boundaries={props.boundaries}
              boundaryFlags={props.boundaryFlags}
              displayedFrame={props.displayedFrame}
              fill
            />
          }
        >
          <DemixView cells={c()} id={props.id} />
        </Show>
      </div>
    </div>
  );
}

/** Cells the empty Cell tab lists. */
const TOP_CELLS = 8;

/**
 * The Cell tab with nothing selected: the cells with the highest peak SNR,
 * each a button that selects it (with its status mark and SNR bar). Reads
 * `qc()`, a snapshot about once a second.
 */
function TopCells(props: { cells: CellStore }): JSX.Element {
  const top = createMemo(() => topBySnr(props.cells.qc()?.rows ?? [], TOP_CELLS));
  const snr = qcMetric('peakSnr');
  const median = createMemo(() => qcMedian(props.cells.qc()?.rows ?? [], 'peakSnr'));
  return (
    <div class="cala-top-cells" data-testid="cell-empty">
      <p class="cala-muted cala-top-cells__lead">
        Click a cell in the field of view or the QC table
        <Show when={top().length > 0}>, or one of the cells with the highest SNR</Show>.
      </p>
      <Show when={top().length > 0}>
        <QcBarKey threshold={snr.thresholdText} median={median()} digits={snr.digits} />
        <ol class="cala-top-cells__list" data-testid="cell-top-list">
          <For each={top()}>
            {(r) => (
              <li>
                <button
                  type="button"
                  class="cala-top-cells__row"
                  onClick={() => props.cells.select(r.id)}
                  data-testid="cell-top-row"
                >
                  <span class="cala-top-cells__id num">
                    <QcDot status={qcStatus(r)} />#{r.id}
                  </span>
                  <Meter
                    value={r.peakSnr}
                    min={snr.range!.min}
                    scale={snr.range!.scale}
                    max={snr.range!.max}
                    target={snr.threshold}
                    targetTitle={thresholdTitle(snr)}
                    median={median()?.value}
                    medianTitle={median()?.title}
                    label={`Cell ${r.id} peak SNR`}
                    format={(v) => v.toFixed(1)}
                    size="sm"
                  />
                  <span class="num">{metricText(snr, r.peakSnr)}</span>
                </button>
              </li>
            )}
          </For>
        </ol>
      </Show>
    </div>
  );
}

/** The clicked cell: footprint, facts, QC and trace (the right-hand column's Cell tab). */
export function SelectedCellPanel(props: {
  cells: CellStore;
  fps: number;
  /** First frames of sessions 2.. of a multi-session run (marked on the trace). */
  boundaries?: readonly number[];
  /** Their health flags (Joint runs; `boundary-flags.ts`). */
  boundaryFlags?: readonly { frame: number; severity: BoundarySeverity }[];
  /** The frame the video shows (live runs with smooth playback): the trace's followed window ends there. */
  displayedFrame?: () => number | null;
}): JSX.Element {
  const [scale, setScale] = createSignal<FootprintScale>('linear');
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
      <Show when={props.cells.selected()} fallback={<TopCells cells={props.cells} />}>
        {(id) => (
          <SelectedCell
            cells={props.cells}
            id={id()}
            fps={props.fps}
            scale={scale()}
            boundaries={props.boundaries}
            boundaryFlags={props.boundaryFlags}
            displayedFrame={props.displayedFrame}
          />
        )}
      </Show>
    </SidePanel>
  );
}
