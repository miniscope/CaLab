import { createEffect, createMemo, createSignal, For, Show, type JSX } from 'solid-js';
import { DashboardPanel } from '@calab/ui';
import { OKABE_ITO, viridisRGB } from '@calab/ui/chart';
import { renderOverlay, pickCell, type Rgb } from '../lib/cell-overlay.ts';
import { NEW_CELL_FRAMES, type CellStore } from '../lib/cell-store.ts';
import { grayToImageData, toGray8 } from '../lib/frame-display.ts';
import type { BatchPreviews } from '../lib/pipeline-engine.ts';
import type { PipelineStore } from '../lib/pipeline-store.ts';
import type { PreviewImage } from '../lib/preview.ts';
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
import { PreviewCanvas } from './PreviewCanvas.tsx';
import { createHeldRange, RangeControl, type HeldRange } from './RangeControl.tsx';

type View = keyof Omit<BatchPreviews, 'frame'>;

const VIEW_LABEL: Record<View, string> = {
  raw: 'Raw',
  preprocessed: 'Preprocessed (hot pixels, flicker, glow, lines)',
  corrected: 'Motion-corrected',
  output: 'Motion-corrected, background removed',
};
const INPUT_VIEWS: View[] = ['raw', 'preprocessed', 'corrected'];

const NEW_COLOR: Rgb = [0xf0, 0xe4, 0x42]; // Okabe-Ito yellow

/** Outline colour by when the cell was found: early blue to late green (viridis .2-.7). */
function foundColor(firstSeen: number | undefined, frame: number): Rgb {
  const t = firstSeen === undefined || frame <= 0 ? 1 : firstSeen / frame;
  return viridisRGB(0.2 + 0.5 * Math.min(1, Math.max(0, t)));
}

/**
 * Fills the space it is given and centres a box of the recording's aspect
 * ratio, as large as fits (CSS container units: no measuring in JS).
 */
function FitStage(props: { width: number; height: number; children: JSX.Element }): JSX.Element {
  return (
    <div class="cala-fit">
      <div
        class="cala-fit__box"
        style={{
          width: `min(100cqw, calc(100cqh * ${props.width / props.height}))`,
          'aspect-ratio': `${props.width} / ${props.height}`,
        }}
      >
        {props.children}
      </div>
    </div>
  );
}

/** The corrected video with the cell outlines on top; click a cell to select it. */
function CellsView(props: {
  image: PreviewImage | null;
  cells: CellStore;
  width: number;
  height: number;
  mode: ColorMode;
  residual: boolean;
  held: HeldRange;
}): JSX.Element {
  let video!: HTMLCanvasElement;
  let overlay!: HTMLCanvasElement;
  let heat!: HTMLCanvasElement;

  // Residual map: one pixel per block, stretched over the field of view.
  const residualMap = () => (props.residual ? (props.cells.qc()?.residual ?? null) : null);
  createEffect(() => {
    const m = residualMap();
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
  createEffect(() => {
    const img = props.image;
    props.held.revision();
    const ctx = video.getContext('2d');
    if (!img) {
      props.held.reset();
      return;
    }
    if (!ctx) return;
    const range = props.held.observe(img.data);
    if (!range) return;
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
    const mode = props.mode;
    const qc = mode === 'found' ? null : props.cells.qc();
    const est = mode === 'status' ? props.cells.established() : null;
    const scale = qc ? modeScale(mode, qc.rows) : { lo: 0, hi: 1 };
    const rgba = renderOverlay(g, {
      selected,
      color: (id) => {
        if (mode !== 'found')
          return qcColor(mode, qc?.byId.get(id), est?.get(id), scale, viridisRGB);
        return props.cells.age(id) < NEW_CELL_FRAMES
          ? NEW_COLOR
          : foundColor(props.cells.firstSeen(id), frame);
      },
      fill: (id) => {
        if (mode !== 'found') return 0;
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
    <div class="cala-cells-stage" data-testid="cells-view">
      <canvas ref={video} class="cala-cells-layer" aria-label="Motion-corrected video" />
      <canvas
        ref={heat}
        class="cala-heat-layer"
        aria-label="Residual map"
        data-testid="residual-layer"
        style={heatStyle()}
        hidden={!props.residual}
      />
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

/** Live video: a selectable pipeline stage next to the cells on the cleaned video. */
export function VideoPanel(props: {
  store: PipelineStore;
  cells: CellStore;
  width: number;
  height: number;
}): JSX.Element {
  const [input, setInput] = createSignal<View>('raw');
  const [mode, setMode] = createSignal<ColorMode>('pass');
  const [residual, setResidual] = createSignal(false);
  const rawHeld = createHeldRange();
  const cellsHeld = createHeldRange();
  const swatch = (t: number) => `rgb(${viridisRGB(t).join(',')})`;
  const scale = createMemo(() => modeScale(mode(), props.cells.qc()?.rows ?? []));
  const residualTop = createMemo(() => {
    const m = props.cells.qc()?.residual;
    return m ? residualMax(m) : 1;
  });
  const fmtScale = (v: number) => (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(2));

  return (
    <DashboardPanel id="video" variant="data" class="cala-video-panel">
      <figure class="cala-pane">
        <div class="cala-pane__head">
          <select
            class="cala-view-select"
            aria-label="View"
            value={input()}
            onChange={(e) => setInput(e.currentTarget.value as View)}
          >
            <For each={INPUT_VIEWS}>{(v) => <option value={v}>{VIEW_LABEL[v]}</option>}</For>
          </select>
          <RangeControl held={rawHeld} label="Video" />
        </div>
        <FitStage width={props.width} height={props.height}>
          <div class="cala-stage">
            <PreviewCanvas
              image={props.store.previews()?.[input()] ?? null}
              label={VIEW_LABEL[input()]}
              held={rawHeld}
            />
          </div>
        </FitStage>
      </figure>
      <figure class="cala-pane">
        <div class="cala-pane__head">
          <h2 class="panel-label">Cells (click one)</h2>
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
          <label
            class="cala-check"
            title="Residual left after the model, in noise units: hot blocks without an outline are signal no cell explains yet."
          >
            <input
              type="checkbox"
              data-testid="residual-toggle"
              checked={residual()}
              onChange={(e) => setResidual(e.currentTarget.checked)}
            />
            Residual
          </label>
          <RangeControl held={cellsHeld} label="Cells video" />
        </div>
        <div class="cala-legend cala-legend--row" data-testid="color-legend">
          <Show when={mode() === 'found'}>
            found
            <span class="cala-legend__swatch" style={{ background: swatch(0.2) }} />
            early
            <span class="cala-legend__swatch" style={{ background: swatch(0.7) }} />
            late
            <span class="cala-legend__swatch" style={{ background: OKABE_ITO.yellow }} />
            new
          </Show>
          <Show when={mode() === 'pass'}>
            <span class="cala-legend__swatch" style={{ background: rgbCss(PASS_RGB) }} />
            passes
            <span class="cala-legend__swatch" style={{ background: rgbCss(FAIL_RGB) }} />
            fails
            <span class="cala-legend__swatch" style={{ background: rgbCss(UNKNOWN_RGB) }} />
            not measured
          </Show>
          <Show when={mode() === 'status'}>
            <span class="cala-legend__swatch" style={{ background: rgbCss(ESTABLISHED_RGB) }} />
            established
            <span class="cala-legend__swatch" style={{ background: rgbCss(PROBATION_RGB) }} />
            probation
            <span class="cala-legend__swatch" style={{ background: rgbCss(UNKNOWN_RGB) }} />
            unknown
          </Show>
          <Show when={mode() !== 'found' && mode() !== 'pass' && mode() !== 'status'}>
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
          <Show when={COLOR_MODES[mode()].note}>
            <span class="cala-legend__note">({COLOR_MODES[mode()].note})</span>
          </Show>
          <Show when={residual()}>
            <span class="cala-legend__note">residual 0</span>
            <span
              class="cala-legend__ramp"
              style={{
                background: `linear-gradient(90deg, ${heatCss(0.1)}, ${heatCss(0.5)}, ${heatCss(1)})`,
              }}
            />
            {residualTop().toFixed(1)} (log, noise var above 1)
          </Show>
        </div>
        <FitStage width={props.width} height={props.height}>
          <CellsView
            image={props.store.previews()?.output ?? null}
            cells={props.cells}
            width={props.width}
            height={props.height}
            mode={mode()}
            residual={residual()}
            held={cellsHeld}
          />
        </FitStage>
      </figure>
    </DashboardPanel>
  );
}
