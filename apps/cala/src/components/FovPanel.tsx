import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  type JSX,
} from 'solid-js';
import { DashboardPanel, SegmentedControl } from '@calab/ui';
import { OKABE_ITO, viridisRGB } from '@calab/ui/chart';
import { pickCell, renderOverlay, type OverlayMode, type Rgb } from '../lib/cell-overlay.ts';
import { NEW_CELL_FRAMES, type CellStore } from '../lib/cell-store.ts';
import { grayToImageData, toGray8 } from '../lib/frame-display.ts';
import {
  FIT_VIEW,
  MAX_ZOOM,
  oneToOneZoom,
  panBy,
  centreOn,
  viewTransform,
  visibleRect,
  zoomAt,
  type FovView,
} from '../lib/fov-view.ts';
import type { BatchPreviews } from '../lib/pipeline-engine.ts';
import type { PreviewImage } from '../lib/preview.ts';
import type { DisplayRange } from '../lib/frame-display.ts';
import type { PipelineStore } from '../lib/pipeline-store.ts';
import {
  COLOR_MODES,
  ESTABLISHED_RGB,
  FAIL_RGB,
  heatCss,
  modeScale,
  PASS_RGB,
  PROBATION_RGB,
  qcColor,
  residualMax,
  residualRgba,
  rgbCss,
  UNKNOWN_RGB,
  type ColorMode,
} from '../lib/qc-colors.ts';
import { createHeldRange, RangeControl, type HeldRange } from './RangeControl.tsx';

export type FovViewName = keyof Omit<BatchPreviews, 'frame'>;

const VIEWS: FovViewOption[] = [
  { value: 'raw', label: 'Raw', title: 'The frame as recorded.' },
  {
    value: 'preprocessed',
    label: 'Preprocessed',
    title: 'After hot pixels, flicker, glow flattening and line removal, before motion.',
  },
  { value: 'corrected', label: 'Motion-corrected', title: 'Registered to the motion template.' },
  {
    value: 'output',
    label: 'Bg removed',
    title: 'Motion-corrected with the background floor removed: what the cell model fits.',
  },
  {
    value: 'residual',
    label: 'Residual',
    title:
      'What the cell model leaves unexplained in the background-removed frame (the frame minus every footprint times its trace). Light without a cell shows here.',
  },
];

/** A view the FOV toolbar offers. */
export interface FovViewOption {
  value: string;
  label: string;
  title: string;
}

/**
 * What the field of view shows: the live pipeline's previews
 * (`pipelineFovSource`), or a saved result's images (the result viewer).
 */
export interface FovSource {
  views: readonly FovViewOption[];
  initial: string;
  /** The image of a view (reactive; null: none yet). */
  image(view: string): PreviewImage | null;
  /** Frame the images show, for the readout (null: none, or not one frame). */
  frame(): number | null;
  /** A fixed display range per view; absent or null: fit to the first images, then held. */
  fixedRange?(view: string): DisplayRange | null;
  /** Ask for the residual frame while that view is shown (the live pipeline). */
  setResidual?(on: boolean): void;
  /** Text over a view without an image. */
  emptyText?(view: string): string | null;
}

/** The live pipeline's previews as an FOV source. */
export function pipelineFovSource(store: PipelineStore): FovSource {
  return {
    views: VIEWS,
    initial: 'output',
    image: (v) => store.previews()?.[v as FovViewName] ?? null,
    frame: () => store.previews()?.frame ?? null,
    setResidual: (on) => store.setResidual(on),
    emptyText: (v) =>
      v === 'residual'
        ? 'The residual comes with the frames processed while the model has cells: it shows from the next batch of a running pass.'
        : null,
  };
}

const OVERLAYS: { value: OverlayMode; label: string; title: string }[] = [
  { value: 'off', label: 'Off', title: 'No cells drawn (the selected cell keeps its outline).' },
  { value: 'contours', label: 'Contours', title: 'Outline of each cell at 35% of its peak.' },
  {
    value: 'footprints',
    label: 'Footprints',
    title: 'Each footprint over its full extent, opacity = value over its own peak (no threshold).',
  },
  { value: 'both', label: 'Both', title: 'Filled footprints with their outlines.' },
];

const NEW_COLOR: Rgb = [0xf0, 0xe4, 0x42]; // Okabe-Ito yellow
const WHEEL_ZOOM = 0.0015;
/** A press that moves less than this (px) is a click, not a drag. */
const CLICK_SLOP = 4;

/** Outline colour by when the cell was found: early blue to late green (viridis .2-.7). */
function foundColor(firstSeen: number | undefined, frame: number): Rgb {
  const t = firstSeen === undefined || frame <= 0 ? 1 : firstSeen / frame;
  return viridisRGB(0.2 + 0.5 * Math.min(1, Math.max(0, t)));
}

const swatch = (t: number) => `rgb(${viridisRGB(t).join(',')})`;
const fmtScale = (v: number) => (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(2));

/** The colour-by legend, on a fixed scale per mode. */
function ColorLegend(props: { cells: CellStore; mode: ColorMode; residual: boolean }): JSX.Element {
  const scale = createMemo(() => modeScale(props.mode, props.cells.qc()?.rows ?? []));
  const residualTop = createMemo(() => {
    const m = props.cells.qc()?.residual;
    return m ? residualMax(m) : 1;
  });
  return (
    <div class="cala-legend cala-legend--row" data-testid="color-legend">
      <Show when={props.mode === 'found'}>
        <span class="cala-legend__swatch" style={{ background: OKABE_ITO.yellow }} />
        new
        <span class="cala-legend__swatch" style={{ background: swatch(0.2) }} />
        early
        <span
          class="cala-legend__ramp"
          style={{ background: `linear-gradient(90deg, ${swatch(0.2)}, ${swatch(0.7)})` }}
        />
        late
      </Show>
      <Show when={props.mode === 'pass'}>
        <span class="cala-legend__swatch" style={{ background: rgbCss(PASS_RGB) }} />
        passes
        <span class="cala-legend__swatch" style={{ background: rgbCss(FAIL_RGB) }} />
        fails
        <span class="cala-legend__swatch" style={{ background: rgbCss(UNKNOWN_RGB) }} />
        not measured
      </Show>
      <Show when={props.mode === 'status'}>
        <span class="cala-legend__swatch" style={{ background: rgbCss(ESTABLISHED_RGB) }} />
        established
        <span class="cala-legend__swatch" style={{ background: rgbCss(PROBATION_RGB) }} />
        probation
        <span class="cala-legend__swatch" style={{ background: rgbCss(UNKNOWN_RGB) }} />
        unknown
      </Show>
      <Show when={props.mode !== 'found' && props.mode !== 'pass' && props.mode !== 'status'}>
        {fmtScale(scale().lo)}
        <span
          class="cala-legend__ramp"
          style={{
            background: `linear-gradient(90deg, ${[0, 0.25, 0.5, 0.75, 1].map(swatch).join(',')})`,
          }}
        />
        {fmtScale(scale().hi)}
        <span class="cala-legend__swatch" style={{ background: rgbCss(UNKNOWN_RGB) }} />
        n/a
      </Show>
      <Show when={COLOR_MODES[props.mode].note}>
        <span class="cala-legend__note">({COLOR_MODES[props.mode].note})</span>
      </Show>
      <Show when={props.residual}>
        <span class="cala-legend__break">
          residual map 0
          <span
            class="cala-legend__ramp"
            style={{
              background: `linear-gradient(90deg, ${heatCss(0.1)}, ${heatCss(0.5)}, ${heatCss(1)})`,
            }}
          />
          {residualTop().toFixed(1)} (log, noise var above 1)
        </span>
      </Show>
    </div>
  );
}

/**
 * The field of view: one image (a pipeline stage picked in the toolbar) with
 * the cells drawn over it, zoom (wheel, buttons, Fit, 1:1), drag-to-pan and
 * a minimap while zoomed. Zoom and pan are a CSS transform of the layers, so
 * they cost nothing per pipeline frame; the canvases redraw only when a new
 * preview or library arrives, as before.
 */
export function FovPanel(props: {
  source: FovSource;
  cells: CellStore;
  width: number;
  height: number;
  fps: number;
}): JSX.Element {
  // The source is fixed for the panel's life (the live pipeline, or one saved result).
  // eslint-disable-next-line solid/reactivity
  const src = props.source;
  const label = (v: string) => src.views.find((x) => x.value === v)?.label ?? v;
  const [view, setView] = createSignal<string>(src.initial);
  const [overlay, setOverlay] = createSignal<OverlayMode>('contours');
  const [mode, setMode] = createSignal<ColorMode>('pass');
  const [residualMap, setResidualMap] = createSignal(false);
  const [card, setCard] = createSignal(true);
  const [fov, setFov] = createSignal<FovView>(FIT_VIEW);
  // One fixed display range per view: switching views never re-fits. A source
  // with a fixed range per view (a saved result) is drawn with it, never fitted.
  const held = Object.fromEntries(src.views.map((v) => [v.value, createHeldRange()])) as Record<
    string,
    HeldRange
  >;
  const applyFixed = () => {
    for (const v of src.views) {
      const r = src.fixedRange?.(v.value);
      if (r) held[v.value].setManual(r);
    }
  };
  applyFixed();

  // The residual frame is computed in the worker only while it is shown.
  createEffect(() => src.setResidual?.(view() === 'residual'));
  onCleanup(() => src.setResidual?.(false));

  let stage!: HTMLDivElement;
  let video!: HTMLCanvasElement;
  let overlayCanvas!: HTMLCanvasElement;
  let heat!: HTMLCanvasElement;
  let minimap!: HTMLCanvasElement;

  const image = () => src.image(view());
  const zoomed = () => fov().zoom > 1.0001;

  // Video layer: the picked view, with its own held range.
  createEffect(() => {
    const frame = src.frame();
    const v = view();
    const h = held[v];
    h.revision();
    const img = src.image(v);
    if (frame === null && !img) {
      // A new run: every view fits afresh.
      for (const r of Object.values(held)) r.reset();
      applyFixed();
    }
    const ctx = video.getContext('2d');
    if (!ctx) return;
    if (!img) {
      ctx.clearRect(0, 0, video.width, video.height);
      return;
    }
    const range = h.observe(img.data);
    if (!range) return;
    if (video.width !== img.width) video.width = img.width;
    if (video.height !== img.height) video.height = img.height;
    ctx.putImageData(grayToImageData(toGray8(img.data, 0, range), img.width, img.height), 0, 0);
    if (zoomed()) drawMinimap();
  });

  function drawMinimap(): void {
    const ctx = minimap?.getContext('2d');
    if (!ctx || video.width === 0) return;
    if (minimap.width !== video.width) minimap.width = video.width;
    if (minimap.height !== video.height) minimap.height = video.height;
    ctx.drawImage(video, 0, 0);
  }
  createEffect(() => {
    if (zoomed()) queueMicrotask(drawMinimap);
  });

  // Residual heat map: one pixel per block, stretched over the field of view.
  createEffect(() => {
    const m = residualMap() ? (props.cells.qc()?.residual ?? null) : null;
    const ctx = heat.getContext('2d');
    if (!ctx) return;
    if (!m || m.blocksWide === 0) {
      ctx.clearRect(0, 0, heat.width, heat.height);
      return;
    }
    if (heat.width !== m.blocksWide) heat.width = m.blocksWide;
    if (heat.height !== m.blocksHigh) heat.height = m.blocksHigh;
    const rgba = residualRgba(m);
    ctx.putImageData(
      new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, m.blocksWide, m.blocksHigh),
      0,
      0,
    );
  });
  const heatStyle = () => {
    const m = props.cells.qc()?.residual;
    if (!m || m.blocksWide === 0) return {};
    return {
      width: `${((m.blocksWide * m.blockPx) / props.width) * 100}%`,
      height: `${((m.blocksHigh * m.blockPx) / props.height) * 100}%`,
    };
  };

  // Cells: redraw on a new library, selection, mode, or every 50 frames (new-cell fade).
  const fadeTick = createMemo(() => Math.floor(props.cells.frame() / 50));
  createEffect(() => {
    const g = props.cells.geometry();
    const selected = props.cells.selected();
    const show = overlay();
    fadeTick();
    const ctx = overlayCanvas.getContext('2d');
    if (!ctx) return;
    if (overlayCanvas.width !== props.width) overlayCanvas.width = props.width;
    if (overlayCanvas.height !== props.height) overlayCanvas.height = props.height;
    if (!g) {
      ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
      return;
    }
    const frame = props.cells.frame();
    const m = mode();
    const qc = m === 'found' ? null : props.cells.qc();
    const est = m === 'status' ? props.cells.established() : null;
    const scale = qc ? modeScale(m, qc.rows) : { lo: 0, hi: 1 };
    const rgba = renderOverlay(g, {
      selected,
      mode: show,
      color: (id) => {
        if (m !== 'found') return qcColor(m, qc?.byId.get(id), est?.get(id), scale, viridisRGB);
        return props.cells.age(id) < NEW_CELL_FRAMES
          ? NEW_COLOR
          : foundColor(props.cells.firstSeen(id), frame);
      },
      fill: (id) => {
        if (m !== 'found') return 0;
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

  // ---- zoom and pan ----
  const stagePoint = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = stage.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  };
  const zoomBy = (factor: number, px = 0.5, py = 0.5) => setFov((v) => zoomAt(v, factor, px, py));
  onMount(() => {
    // Not passive: the wheel zooms the image instead of scrolling the page.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const [px, py] = stagePoint(e);
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoomBy(Math.exp(-dy * WHEEL_ZOOM), px, py);
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    onCleanup(() => stage.removeEventListener('wheel', onWheel));
  });

  let press: { x: number; y: number; id: number; moved: boolean } | null = null;
  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    press = { x: e.clientX, y: e.clientY, id: e.pointerId, moved: false };
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!press || press.id !== e.pointerId) return;
    const dx = e.clientX - press.x;
    const dy = e.clientY - press.y;
    if (!press.moved && Math.hypot(dx, dy) < CLICK_SLOP) return;
    if (!press.moved) {
      press.moved = true;
      stage.setPointerCapture?.(e.pointerId);
    }
    const r = stage.getBoundingClientRect();
    setFov((v) => panBy(v, dx / r.width, dy / r.height));
    press.x = e.clientX;
    press.y = e.clientY;
  };
  const onPointerUp = (e: PointerEvent) => {
    const p = press;
    press = null;
    if (!p || p.id !== e.pointerId) return;
    stage.releasePointerCapture?.(e.pointerId);
    if (p.moved) return;
    // A click: pick the cell under it (the overlay's rect already includes the zoom).
    const g = props.cells.geometry();
    if (!g) return;
    const rect = overlayCanvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * g.width;
    const y = ((e.clientY - rect.top) / rect.height) * g.height;
    props.cells.select(pickCell(g, x, y));
  };
  const onMinimap = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setFov((v) => centreOn(v, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height));
  };
  const oneToOne = () => {
    const z = oneToOneZoom(props.width, stage.getBoundingClientRect().width);
    setFov((v) => zoomAt({ ...v, zoom: 1 }, z, 0.5, 0.5));
  };

  const minutes = () => {
    const f = src.frame();
    if (f === null || !(props.fps > 0)) return null;
    return (f + 1) / props.fps / 60;
  };

  return (
    <DashboardPanel id="video" variant="data" class="cala-fov-panel">
      <div class="cala-fov__toolbar">
        <SegmentedControl
          options={[...src.views]}
          value={view()}
          onChange={setView}
          aria-label="View"
          size="sm"
          testid="view-select"
        />
        <RangeControl held={held[view()]} label={label(view())} />
      </div>
      <div class="cala-fov__area">
        <div
          ref={stage}
          class="cala-fov__stage"
          classList={{ 'cala-fov__stage--zoomed': zoomed() }}
          style={{
            'aspect-ratio': `${props.width} / ${props.height}`,
            '--cala-aspect': String(props.width / Math.max(1, props.height)),
          }}
          data-testid="cells-view"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => (press = null)}
        >
          <div class="cala-fov__world" style={{ transform: viewTransform(fov()) }}>
            <canvas ref={video} class="cala-fov__layer" aria-label={label(view())} />
            <canvas
              ref={heat}
              class="cala-heat-layer"
              aria-label="Residual map"
              data-testid="residual-layer"
              style={heatStyle()}
              hidden={!residualMap()}
            />
            <canvas
              ref={overlayCanvas}
              class="cala-fov__layer cala-cells-overlay"
              aria-label="Cells (click one)"
              data-testid="cells-overlay"
            />
          </div>
          <Show when={!image() && src.emptyText?.(view())}>
            {(text) => <p class="cala-fov__empty">{text()}</p>}
          </Show>
          <div
            class="cala-fov__card"
            classList={{ 'cala-fov__card--closed': !card() }}
            onPointerDown={(e) => e.stopPropagation()}
            onPointerUp={(e) => e.stopPropagation()}
          >
            <div class="cala-fov__card-head">
              <SegmentedControl
                options={OVERLAYS}
                value={overlay()}
                onChange={setOverlay}
                aria-label="Cell overlay"
                size="sm"
                testid="overlay-mode"
              />
              <button
                type="button"
                class="cala-icon-btn"
                aria-expanded={card()}
                aria-label={card() ? 'Hide overlay settings' : 'Show overlay settings'}
                title={card() ? 'Hide colour settings' : 'Show colour settings'}
                onClick={() => setCard((v) => !v)}
              >
                {card() ? '−' : '+'}
              </button>
            </div>
            <div class="cala-fov__card-body" hidden={!card()}>
              <label class="cala-fov__card-row">
                <span class="cala-fov__card-label">Colour by</span>
                <select
                  class="cala-view-select"
                  aria-label="Colour cells by"
                  data-testid="color-mode"
                  value={mode()}
                  onChange={(e) => setMode(e.currentTarget.value as ColorMode)}
                >
                  <For each={Object.keys(COLOR_MODES) as ColorMode[]}>
                    {(m) => <option value={m}>{COLOR_MODES[m].label}</option>}
                  </For>
                </select>
              </label>
              <ColorLegend cells={props.cells} mode={mode()} residual={residualMap()} />
              <label
                class="cala-check cala-fov__card-row"
                title="Residual left after the model, in noise units, per block: hot blocks without an outline are signal no cell explains yet."
              >
                <input
                  type="checkbox"
                  data-testid="residual-toggle"
                  checked={residualMap()}
                  onChange={(e) => setResidualMap(e.currentTarget.checked)}
                />
                Residual heat map
              </label>
            </div>
          </div>
          <Show when={zoomed()}>
            <div
              class="cala-fov__minimap"
              data-testid="fov-minimap"
              title="Click to move the view"
              onPointerDown={(e) => e.stopPropagation()}
              onPointerUp={(e) => e.stopPropagation()}
              onClick={onMinimap}
              style={{ 'aspect-ratio': `${props.width} / ${props.height}` }}
            >
              <canvas ref={minimap} class="cala-fov__layer" aria-hidden="true" />
              <div
                class="cala-fov__minimap-box"
                style={(() => {
                  const [x, y, w, h] = visibleRect(fov());
                  return {
                    left: `${x * 100}%`,
                    top: `${y * 100}%`,
                    width: `${w * 100}%`,
                    height: `${h * 100}%`,
                  };
                })()}
              />
            </div>
          </Show>
          <div class="cala-fov__hud" data-testid="fov-hud">
            {label(view())}
            <Show when={src.frame() !== null}>
              <> &middot; frame {((src.frame() ?? 0) + 1).toLocaleString()}</>
            </Show>
            <Show when={minutes()}>{(m) => <> &middot; {m().toFixed(1)} min</>}</Show>
          </div>
          <div
            class="cala-fov__zoom"
            onPointerDown={(e) => e.stopPropagation()}
            onPointerUp={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              aria-label="Zoom out"
              disabled={!zoomed()}
              onClick={() => zoomBy(1 / 1.5)}
            >
              &minus;
            </button>
            <span class="cala-fov__zoom-level" data-testid="fov-zoom">
              {Math.round(fov().zoom * 100)}%
            </span>
            <button
              type="button"
              aria-label="Zoom in"
              disabled={fov().zoom >= MAX_ZOOM}
              onClick={() => zoomBy(1.5)}
            >
              +
            </button>
            <button
              type="button"
              title="Fit the whole field of view"
              onClick={() => setFov(FIT_VIEW)}
            >
              Fit
            </button>
            <button type="button" title="One recording pixel per screen pixel" onClick={oneToOne}>
              1:1
            </button>
          </div>
        </div>
      </div>
    </DashboardPanel>
  );
}
