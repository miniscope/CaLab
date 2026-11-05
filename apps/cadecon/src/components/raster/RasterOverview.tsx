import {
  onMount,
  onCleanup,
  createEffect,
  createMemo,
  createSignal,
  on,
  Show,
  type JSX,
} from 'solid-js';
import { sortCells, rowOfCell, isNearNoiseFloor, FLAG_LABELS, type CellSortKey } from '@calab/core';
import { parsedData, effectiveShape, swapped, durationSeconds } from '../../lib/data-store.ts';
import {
  subsetRectangles,
  selectedSubsetIdx,
  setSelectedSubsetIdx,
} from '../../lib/subset-store.ts';
import { VIRIDIS_LUT, niceTicks, AXIS_TEXT, viridisCss, getThemeColors } from '@calab/ui/chart';
import { overview } from '../../lib/overview-store.ts';
import {
  highlightedCells,
  inspectedCellIndex,
  setInspectedCellIndex,
  rasterSort,
  setRasterSort,
} from '../../lib/viz-store.ts';
import {
  poolRawMax,
  poolMatrixMax,
  pooledBounds,
  normalizeByte,
  smoothWidthFrames,
} from '../../lib/raster-pool.ts';
import '../../styles/raster.css';

// Plot margins (CSS px) reserved for the cell axis (left) and time axis
// (bottom); the heatmap fills the inner plot rect. No intensity colorbar —
// viridis runs low→high activity and the absolute values aren't meaningful.
// Right margin is just enough to keep the last time-axis label from clipping.
// Left of the heatmap: cell axis, then the annotation strip (SNR quantile
// colour + flag column). Right: the highlight marks.
const STRIP_SNR_W = 6;
const STRIP_FLAG_W = 4;
const STRIP_GAP = 2;
const STRIP_W = STRIP_SNR_W + STRIP_FLAG_W + 2 * STRIP_GAP;
const MARGIN_LEFT = 42 + STRIP_W;
const MARGIN_RIGHT = 14;
const MARGIN_TOP = 10;
const MARGIN_BOTTOM = 30;

// High-contrast colors chosen to stand out against viridis (purple-teal-yellow):
// warm reds, oranges, and pinks that don't appear in the viridis palette. This
// is deliberately NOT the categorical Okabe-Ito series palette — the goal here
// is contrast against the colormap, not distinctness among many series.
const SUBSET_STROKE = [
  '#ff3333', // red
  '#ff8800', // orange
  '#ff33aa', // magenta
  '#ffffff', // white
  '#ff5555', // coral
  '#ffaa00', // amber
  '#ff55cc', // pink
  '#cccccc', // silver
];

const SUBSET_FILL = [
  'rgba(255, 51, 51, 0.12)',
  'rgba(255, 136, 0, 0.12)',
  'rgba(255, 51, 170, 0.12)',
  'rgba(255, 255, 255, 0.12)',
  'rgba(255, 85, 85, 0.12)',
  'rgba(255, 170, 0, 0.12)',
  'rgba(255, 85, 204, 0.12)',
  'rgba(204, 204, 204, 0.12)',
];

/** Format an axis value: integers plain, otherwise one decimal. */
function formatTick(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

const SORT_OPTIONS: { key: CellSortKey; label: string }[] = [
  { key: 'index', label: 'Index' },
  { key: 'snr', label: 'SNR' },
  { key: 'eventRate', label: 'Event rate' },
  { key: 'flags', label: 'Flags' },
];

export function RasterOverview(): JSX.Element {
  let canvasRef: HTMLCanvasElement | undefined;
  let containerRef: HTMLDivElement | undefined;
  let resizeObserver: ResizeObserver | undefined;

  const [hoverInfo, setHoverInfo] = createSignal<{ x: number; y: number; text: string } | null>(
    null,
  );

  // Display order of cells (row -> cell) and its inverse; index order until
  // the overview exists. Sorting is display only.
  const order = createMemo((): number[] | null => {
    const ov = overview();
    const key = rasterSort();
    if (!ov || key === 'index') return null;
    return sortCells(ov, key);
  });
  const displayRowOf = createMemo(() => {
    const o = order();
    return o ? rowOfCell(o) : null;
  });
  const cellAtRow = (row: number) => order()?.[row] ?? row;
  const rowOfCellIdx = (cell: number) => displayRowOf()?.[cell] ?? cell;
  const isSorted = () => order() != null;

  // Cached inner plot rect (CSS px) for click hit-testing against subset boxes.
  let plotX = MARGIN_LEFT;
  let plotY = MARGIN_TOP;
  let plotW = 0;
  let plotH = 0;

  /** Memoized 1st/99th percentile bounds -- recomputed only when the underlying data changes. */
  const percentileBounds = createMemo(() => {
    const data = parsedData();
    if (!data) return { p1: 0, p99: 1, range: 1 };

    const typedData = data.data;
    const sampleSize = Math.min(typedData.length, 100000);
    const step = Math.max(1, Math.floor(typedData.length / sampleSize));
    const samples: number[] = [];
    for (let i = 0; i < typedData.length; i += step) {
      const v = typedData[i];
      if (Number.isFinite(v)) samples.push(v);
    }
    samples.sort((a, b) => a - b);
    const p1 = samples[Math.floor(samples.length * 0.01)] ?? 0;
    const p99 = samples[Math.floor(samples.length * 0.99)] ?? 1;
    const range = p99 - p1 || 1;
    return { p1, p99, range };
  });

  // Intermediate max-pooled image (normalized bytes), computed once per
  // dataset in a single pass; resizes re-pool from this small image instead of
  // rescanning the full N x T matrix.
  const BASE_MAX_ROWS = 2048;
  const BASE_MAX_COLS = 4096;
  const basePool = createMemo(() => {
    const data = parsedData();
    const shape = effectiveShape();
    if (!data || !shape) return null;
    const [N, T] = shape;
    const dur = durationSeconds();
    const fsHz = dur && dur > 0 ? T / dur : null;
    const w = smoothWidthFrames(T, fsHz);
    const pooled = poolRawMax(
      data.data,
      data.shape[1],
      swapped(),
      N,
      T,
      BASE_MAX_ROWS,
      BASE_MAX_COLS,
      w,
      displayRowOf() ?? undefined,
    );
    return { ...pooled, smoothed: w > 1 };
  });
  let sizedCache: {
    src: object;
    w: number;
    h: number;
    pool: ReturnType<typeof poolMatrixMax>;
    lo: number;
    range: number;
  } | null = null;

  const drawRaster = () => {
    const canvas = canvasRef;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const data = parsedData();
    const shape = effectiveShape();
    if (!data || !shape) return;

    const [N, T] = shape;
    const rect = containerRef?.getBoundingClientRect();
    const displayWidth = rect?.width ?? 800;
    const displayHeight = rect?.height ?? Math.min(Math.max(200, N * 3), 500);
    const dpr = window.devicePixelRatio || 1;

    // Size canvas at physical resolution (also resets ctx transform to identity)
    const physW = Math.round(displayWidth * dpr);
    const physH = Math.round(displayHeight * dpr);
    canvas.width = physW;
    canvas.height = physH;
    canvas.style.width = `${displayWidth}px`;
    canvas.style.height = `${displayHeight}px`;

    // Inner plot rect (CSS px) — cached for click hit-testing.
    plotX = MARGIN_LEFT;
    plotY = MARGIN_TOP;
    plotW = Math.max(1, displayWidth - MARGIN_LEFT - MARGIN_RIGHT);
    plotH = Math.max(1, displayHeight - MARGIN_TOP - MARGIN_BOTTOM);

    // Draw heatmap into the plot rect at physical resolution (putImageData
    // ignores canvas transforms, so position/size in physical pixels).
    const ppX = Math.round(plotX * dpr);
    const ppY = Math.round(plotY * dpr);
    const ppW = Math.max(1, Math.round(plotW * dpr));
    const ppH = Math.max(1, Math.round(plotH * dpr));
    const imageData = ctx.createImageData(ppW, ppH);
    const pixels = imageData.data;

    // Max-pool so every cell/frame mapping into a pixel contributes. With fewer
    // cells (frames) than pixels, pooling is the identity and each cell (frame)
    // spans >=1 pixel row (column).
    const base = basePool();
    if (!base) return;
    if (!sizedCache || sizedCache.src !== base || sizedCache.w !== ppW || sizedCache.h !== ppH) {
      const pool = poolMatrixMax(base.out, base.rows, base.cols, ppH, ppW);
      // Pooling raises the noise floor, so colour bounds come from the pooled
      // values; with no pooling at all use the global raw percentiles.
      const pooledAny = base.smoothed || N * T > pool.rows * pool.cols;
      const bounds = pooledAny
        ? (() => {
            const b = pooledBounds(pool.out);
            return { lo: b.lo, range: b.range };
          })()
        : { lo: percentileBounds().p1, range: percentileBounds().range };
      sizedCache = {
        src: base,
        w: ppW,
        h: ppH,
        pool,
        ...bounds,
      };
    }
    const { out: pooled, rows: pRows, cols: pCols } = sizedCache.pool;
    const { lo, range } = sizedCache;

    for (let py = 0; py < ppH; py++) {
      const pr = Math.min(pRows - 1, Math.floor((py / ppH) * pRows));
      const rowPixelBase = py * ppW;
      for (let px = 0; px < ppW; px++) {
        const normalized = normalizeByte(
          pooled[pr * pCols + Math.min(pCols - 1, Math.floor((px / ppW) * pCols))],
          lo,
          range,
        );
        const offset = (rowPixelBase + px) * 4;
        pixels[offset] = VIRIDIS_LUT[normalized * 3];
        pixels[offset + 1] = VIRIDIS_LUT[normalized * 3 + 1];
        pixels[offset + 2] = VIRIDIS_LUT[normalized * 3 + 2];
        pixels[offset + 3] = 255;
      }
    }

    ctx.putImageData(imageData, ppX, ppY);

    // All subsequent vector drawing is in CSS px.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    drawAxes(ctx, N, T);
    drawAnnotations(ctx, N);
    if (!isSorted()) drawSubsets(ctx, N, T);
  };

  /**
   * Row annotations: SNR quantile colour and flag marks left of the heatmap,
   * highlight marks right of it, and an outline on the inspected row. Rows
   * thinner than a pixel are pooled: a pixel row shows its best SNR rank and
   * any flag/highlight among its cells.
   */
  const drawAnnotations = (ctx: CanvasRenderingContext2D, N: number) => {
    const ov = overview();
    const theme = getThemeColors();
    const stripX = plotX - STRIP_W;
    const rowsPx = Math.max(1, Math.round(plotH));
    const rowH = plotH / rowsPx;
    const hl = highlightedCells();
    if (ov) {
      for (let py = 0; py < rowsPx; py++) {
        const r0 = Math.floor((py / rowsPx) * N);
        const r1 = Math.max(r0 + 1, Math.floor(((py + 1) / rowsPx) * N));
        let best = -1;
        let flagged = false;
        let lit = false;
        for (let r = r0; r < r1 && r < N; r++) {
          const c = cellAtRow(r);
          const rank = ov.snrRank[c];
          if (Number.isFinite(rank) && rank > best) best = rank;
          if (ov.flags[c].length > 0) flagged = true;
          if (hl?.has(c)) lit = true;
        }
        const y = plotY + py * rowH;
        if (best >= 0) {
          ctx.fillStyle = viridisCss(best);
          ctx.fillRect(stripX + STRIP_GAP, y, STRIP_SNR_W, Math.ceil(rowH));
        }
        if (flagged) {
          ctx.fillStyle = '#d32f2f';
          ctx.fillRect(stripX + STRIP_GAP + STRIP_SNR_W + 1, y, STRIP_FLAG_W - 1, Math.ceil(rowH));
        }
        if (lit) {
          ctx.fillStyle = theme.accent;
          ctx.fillRect(plotX + plotW + 2, y, 5, Math.ceil(rowH));
        }
      }
    }
    // Inspected cell: outline its row across the heatmap.
    const sel = inspectedCellIndex();
    if (sel != null && sel < N) {
      const r = rowOfCellIdx(sel);
      const y0 = plotY + (r / N) * plotH;
      const h = Math.max(2, plotH / N);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      ctx.strokeRect(plotX - 0.5, y0 - 0.5, plotW + 1, h + 1);
      ctx.fillStyle = theme.accent;
      ctx.beginPath();
      ctx.moveTo(plotX + plotW + 2, y0 + h / 2);
      ctx.lineTo(plotX + plotW + 9, y0 + h / 2 - 4);
      ctx.lineTo(plotX + plotW + 9, y0 + h / 2 + 4);
      ctx.closePath();
      ctx.fill();
    }
  };

  /** Cell under a canvas-relative point (null outside the rows). */
  const cellAtPoint = (my: number): number | null => {
    const shape = effectiveShape();
    if (!shape || plotH <= 0) return null;
    const row = Math.floor(((my - plotY) / plotH) * shape[0]);
    if (row < 0 || row >= shape[0]) return null;
    return cellAtRow(row);
  };

  const handleMove = (e: MouseEvent) => {
    const canvas = canvasRef;
    if (!canvas) return;
    const b = canvas.getBoundingClientRect();
    const mx = e.clientX - b.left;
    const my = e.clientY - b.top;
    const cell = mx >= plotX - STRIP_W && mx <= plotX + plotW ? cellAtPoint(my) : null;
    if (cell == null) {
      setHoverInfo(null);
      return;
    }
    const ov = overview();
    const parts = [`Cell ${cell}`];
    if (ov) {
      const c = ov.cells[cell];
      parts.push(
        `SNR ${Number.isFinite(c.snr) ? c.snr.toFixed(1) : '--'}${isNearNoiseFloor(c.snr) ? ' (≈ noise floor)' : ''}`,
      );
      const f = ov.flags[cell];
      if (f.length) parts.push(f.map((k) => FLAG_LABELS[k]).join(', '));
    }
    setHoverInfo({ x: mx, y: my, text: parts.join(' · ') });
  };

  /** Time axis (bottom) + cell axis (left). */
  const drawAxes = (ctx: CanvasRenderingContext2D, N: number, T: number) => {
    ctx.fillStyle = AXIS_TEXT;
    ctx.strokeStyle = AXIS_TEXT;
    ctx.lineWidth = 1;
    ctx.font = '10px system-ui, sans-serif';

    // Time axis: seconds when the sampling rate is known, else frame index.
    const dur = durationSeconds();
    const axisMax = dur && dur > 0 ? dur : T;
    const axisUnit = dur && dur > 0 ? 's' : 'frame';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const tv of niceTicks(0, axisMax, 6)) {
      if (tv > axisMax) continue;
      const xPx = plotX + (tv / axisMax) * plotW;
      ctx.beginPath();
      ctx.moveTo(xPx, plotY + plotH);
      ctx.lineTo(xPx, plotY + plotH + 4);
      ctx.stroke();
      ctx.fillText(formatTick(tv), xPx, plotY + plotH + 6);
    }
    ctx.fillText(`Time (${axisUnit})`, plotX + plotW / 2, plotY + plotH + 17);

    // Cell axis: index increasing downward.
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const cv of niceTicks(0, N, 6)) {
      if (cv > N) continue;
      const yPx = plotY + (cv / N) * plotH;
      // The cell axis sits left of the annotation strip.
      const axisX = plotX - STRIP_W;
      ctx.beginPath();
      ctx.moveTo(axisX - 4, yPx);
      ctx.lineTo(axisX, yPx);
      ctx.stroke();
      ctx.fillText(String(cv), axisX - 6, yPx);
    }
    ctx.save();
    ctx.translate(11, plotY + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Cell', 0, 0);
    ctx.restore();
  };

  /** Clickable subset overlay boxes (K1..Kn), positioned within the plot rect. */
  const drawSubsets = (ctx: CanvasRenderingContext2D, N: number, T: number) => {
    const rects = subsetRectangles();
    const selected = selectedSubsetIdx();

    // Reset text alignment — drawAxes leaves it right/middle, which would
    // misplace the label inside its shaded background box.
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    for (const r of rects) {
      const x = plotX + (r.tStart / T) * plotW;
      const w = ((r.tEnd - r.tStart) / T) * plotW;
      const y = plotY + (r.cellStart / N) * plotH;
      const h = ((r.cellEnd - r.cellStart) / N) * plotH;
      const colorIdx = r.idx % SUBSET_STROKE.length;
      const isSelected = r.idx === selected;

      ctx.fillStyle = SUBSET_FILL[colorIdx];
      ctx.fillRect(x, y, w, h);

      ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
      ctx.shadowBlur = 3;
      ctx.strokeStyle = SUBSET_STROKE[colorIdx];
      ctx.lineWidth = isSelected ? 3 : 2;
      ctx.strokeRect(x, y, w, h);
      ctx.shadowBlur = 0;

      const label = `K${r.idx + 1}`;
      ctx.font = 'bold 11px system-ui, sans-serif';
      const textW = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
      ctx.fillRect(x + 2, y + 2, textW + 6, 14);
      ctx.fillStyle = SUBSET_STROKE[colorIdx];
      ctx.fillText(label, x + 5, y + 13);
    }
  };

  const handleClick = (e: MouseEvent) => {
    const canvas = canvasRef;
    if (!canvas) return;

    const shape = effectiveShape();
    if (!shape) return;

    const [N, T] = shape;
    const bRect = canvas.getBoundingClientRect();
    const mx = e.clientX - bRect.left;
    const my = e.clientY - bRect.top;

    // Every click on a row inspects that cell in the Trace Inspector.
    const cell = mx >= plotX - STRIP_W && mx <= plotX + plotW ? cellAtPoint(my) : null;
    if (cell != null) setInspectedCellIndex(cell);
    // Subset boxes are drawn (and clickable) only in index order.
    if (isSorted()) return;

    const rects = subsetRectangles();

    // Check if click is inside any rectangle (reverse order for z-order).
    for (let i = rects.length - 1; i >= 0; i--) {
      const r = rects[i];
      const x = plotX + (r.tStart / T) * plotW;
      const w = ((r.tEnd - r.tStart) / T) * plotW;
      const y = plotY + (r.cellStart / N) * plotH;
      const h = ((r.cellEnd - r.cellStart) / N) * plotH;

      if (mx >= x && mx <= x + w && my >= y && my <= y + h) {
        setSelectedSubsetIdx(selectedSubsetIdx() === r.idx ? null : r.idx);
        return;
      }
    }

    // Click outside all rectangles: deselect.
    setSelectedSubsetIdx(null);
  };

  onMount(() => {
    if (containerRef) {
      resizeObserver = new ResizeObserver(() => drawRaster());
      resizeObserver.observe(containerRef);
    }
    drawRaster();
  });

  onCleanup(() => {
    resizeObserver?.disconnect();
  });

  // Redraw when data, shape, timebase, subsets, or selection changes.
  createEffect(
    on(
      [
        parsedData,
        effectiveShape,
        swapped,
        durationSeconds,
        subsetRectangles,
        selectedSubsetIdx,
        overview,
        order,
        highlightedCells,
        inspectedCellIndex,
      ],
      drawRaster,
    ),
  );

  return (
    <>
      <div class="raster-header">
        <p class="panel-label">Raster Overview</p>
        <label class="raster-header__sort">
          Sort
          <select
            aria-label="Sort raster rows"
            value={rasterSort()}
            disabled={!overview()}
            onChange={(e) => setRasterSort(e.currentTarget.value as CellSortKey)}
          >
            {SORT_OPTIONS.map((o) => (
              <option value={o.key}>{o.label}</option>
            ))}
          </select>
        </label>
      </div>
      <div class="raster-container" ref={containerRef}>
        <canvas
          ref={canvasRef}
          class="raster-canvas"
          onClick={handleClick}
          onMouseMove={handleMove}
          onMouseLeave={() => setHoverInfo(null)}
        />
        <Show when={hoverInfo()}>
          {(h) => (
            <div
              class="raster-tooltip"
              style={
                h().x > plotX + plotW * 0.55
                  ? {
                      right: `${plotX + plotW - h().x + MARGIN_RIGHT + 12}px`,
                      top: `${Math.max(0, h().y - 26)}px`,
                    }
                  : { left: `${h().x + 12}px`, top: `${Math.max(0, h().y - 26)}px` }
              }
            >
              {h().text}
            </div>
          )}
        </Show>
        <Show when={isSorted()}>
          <div class="raster-sorted-note" title="Subset boxes are drawn in index order only">
            Sorted by {SORT_OPTIONS.find((o) => o.key === rasterSort())?.label}; subset boxes hidden
          </div>
        </Show>
      </div>
    </>
  );
}
