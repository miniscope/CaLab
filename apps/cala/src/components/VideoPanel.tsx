import { createEffect, createMemo, createSignal, For, type JSX } from 'solid-js';
import { DashboardPanel } from '@calab/ui';
import { OKABE_ITO, viridisRGB } from '@calab/ui/chart';
import { renderOverlay, pickCell, type Rgb } from '../lib/cell-overlay.ts';
import { NEW_CELL_FRAMES, type CellStore } from '../lib/cell-store.ts';
import { displayRange, grayToImageData, toGray8, type DisplayRange } from '../lib/frame-display.ts';
import type { BatchPreviews } from '../lib/pipeline-engine.ts';
import type { PipelineStore } from '../lib/pipeline-store.ts';
import type { PreviewImage } from '../lib/preview.ts';
import { PreviewCanvas } from './PreviewCanvas.tsx';

type View = keyof Omit<BatchPreviews, 'frame'>;

const VIEW_LABEL: Record<View, string> = {
  raw: 'Raw',
  preprocessed: 'Preprocessed (hot pixels, flicker, glow, lines)',
  corrected: 'Motion-corrected',
  output: 'Motion-corrected, background removed',
};
const INPUT_VIEWS: View[] = ['raw', 'preprocessed', 'corrected'];

const NEW_COLOR: Rgb = [0xf0, 0xe4, 0x42]; // Okabe-Ito yellow
const RANGE_SMOOTHING = 0.3;

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
    <div class="cala-cells-stage" data-testid="cells-view">
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

/** Live video: a selectable pipeline stage next to the cells on the cleaned video. */
export function VideoPanel(props: {
  store: PipelineStore;
  cells: CellStore;
  width: number;
  height: number;
}): JSX.Element {
  const [input, setInput] = createSignal<View>('raw');
  const swatch = (t: number) => `rgb(${viridisRGB(t).join(',')})`;

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
        </div>
        <FitStage width={props.width} height={props.height}>
          <div class="cala-stage">
            <PreviewCanvas
              image={props.store.previews()?.[input()] ?? null}
              label={VIEW_LABEL[input()]}
            />
          </div>
        </FitStage>
      </figure>
      <figure class="cala-pane">
        <div class="cala-pane__head">
          <h2 class="panel-label">Cells (click one)</h2>
          <span class="cala-legend">
            found
            <span class="cala-legend__swatch" style={{ background: swatch(0.2) }} />
            early
            <span class="cala-legend__swatch" style={{ background: swatch(0.7) }} />
            late
            <span class="cala-legend__swatch" style={{ background: OKABE_ITO.yellow }} />
            new
          </span>
        </div>
        <FitStage width={props.width} height={props.height}>
          <CellsView
            image={props.store.previews()?.output ?? null}
            cells={props.cells}
            width={props.width}
            height={props.height}
          />
        </FitStage>
      </figure>
    </DashboardPanel>
  );
}
