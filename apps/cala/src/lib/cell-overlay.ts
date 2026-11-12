/**
 * Footprint geometry for drawing cells over the video: per-cell outline
 * (contour) pixels, a click-target label map, and the overlay image. Pure, so
 * it is unit-tested without a canvas.
 */
import type { LibraryView } from '../workers/slow-types.ts';

/** Outline level: the footprint's region is where it exceeds this share of its peak. */
export const CONTOUR_LEVEL = 0.35;
/** Click target: support pixels above this share of the cell's peak. */
const PICK_LEVEL = 0.15;

export interface CellShape {
  id: number;
  /** Pixel indices inside the outline, and its boundary pixels. */
  inside: Uint32Array;
  contour: Uint32Array;
  /** Bounding box of the support, inclusive-exclusive. */
  y0: number;
  x0: number;
  y1: number;
  x1: number;
  /** Peak of the unfiltered footprint. */
  peak: number;
  /** The full support (every pixel the footprint has), and each pixel's value over the peak (0..1). */
  support: Uint32Array;
  rel: Float32Array;
}

export interface CellGeometry {
  version: number;
  width: number;
  height: number;
  shapes: CellShape[];
  /** Slot of the cell owning each pixel (largest relative weight), -1 for none. */
  label: Int32Array;
}

export function buildGeometry(view: LibraryView, level = CONTOUR_LEVEL): CellGeometry {
  const { width, height } = view;
  const label = new Int32Array(width * height).fill(-1);
  const weight = new Float32Array(width * height);
  const shapes: CellShape[] = [];
  const n = view.ids.length;
  for (let s = 0; s < n; s++) {
    const a = view.starts[s];
    const b = view.starts[s + 1];
    let peak = 0;
    let y0 = height;
    let x0 = width;
    let y1 = 0;
    let x1 = 0;
    for (let k = a; k < b; k++) {
      peak = Math.max(peak, view.values[k]);
      const p = view.pixels[k];
      const y = Math.floor(p / width);
      const x = p - y * width;
      y0 = Math.min(y0, y);
      x0 = Math.min(x0, x);
      y1 = Math.max(y1, y + 1);
      x1 = Math.max(x1, x + 1);
    }
    const inSet = new Set<number>();
    const inside: number[] = [];
    const support = view.pixels.slice(a, b);
    const rel = new Float32Array(b - a);
    if (peak > 0) for (let k = a; k < b; k++) rel[k - a] = Math.max(0, view.values[k] / peak);
    if (peak > 0) {
      for (let k = a; k < b; k++) {
        const rel = view.values[k] / peak;
        const p = view.pixels[k];
        if (rel >= level) {
          inSet.add(p);
          inside.push(p);
        }
        if (rel >= PICK_LEVEL && rel > weight[p]) {
          weight[p] = rel;
          label[p] = s;
        }
      }
    }
    const contour: number[] = [];
    for (const p of inside) {
      const y = Math.floor(p / width);
      const x = p - y * width;
      const edge =
        x === 0 ||
        y === 0 ||
        x === width - 1 ||
        y === height - 1 ||
        !inSet.has(p - 1) ||
        !inSet.has(p + 1) ||
        !inSet.has(p - width) ||
        !inSet.has(p + width);
      if (edge) contour.push(p);
    }
    shapes.push({
      id: view.ids[s],
      inside: Uint32Array.from(inside),
      contour: Uint32Array.from(contour),
      y0: b > a ? y0 : 0,
      x0: b > a ? x0 : 0,
      y1: b > a ? y1 : 0,
      x1: b > a ? x1 : 0,
      peak,
      support,
      rel,
    });
  }
  return { version: view.version, width, height, shapes, label };
}

/** Id of the cell under pixel `(x, y)`, or `null`. */
export function pickCell(g: CellGeometry, x: number, y: number): number | null {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  if (xi < 0 || yi < 0 || xi >= g.width || yi >= g.height) return null;
  const s = g.label[yi * g.width + xi];
  return s >= 0 ? g.shapes[s].id : null;
}

export type Rgb = [number, number, number];

/**
 * What the overlay draws: nothing (the selected cell only), the outlines,
 * the footprints filled over their full extent (opacity = value over the
 * cell's peak, no threshold), or both.
 */
export type OverlayMode = 'off' | 'contours' | 'footprints' | 'both';

export const OVERLAY_MODES: readonly OverlayMode[] = ['off', 'contours', 'footprints', 'both'];

export interface OverlayStyle {
  /** Outline colour of a cell. */
  color(id: number): Rgb;
  /** Fill opacity 0..1 of a cell (0 = outline only), e.g. new cells. */
  fill(id: number): number;
  selected: number | null;
  /** Default `contours`. */
  mode?: OverlayMode;
}

const SELECTED: Rgb = [255, 255, 255];
/** Opacity of a footprint fill at the cell's peak. */
export const FOOTPRINT_ALPHA = 0.6;

/** RGBA overlay (`width * height * 4`), transparent outside the cells. */
export function renderOverlay(g: CellGeometry, style: OverlayStyle, out?: Uint8ClampedArray) {
  const rgba =
    out && out.length === g.width * g.height * 4
      ? out
      : new Uint8ClampedArray(g.width * g.height * 4);
  rgba.fill(0);
  const put = (p: number, c: Rgb, a: number) => {
    const o = p * 4;
    rgba[o] = c[0];
    rgba[o + 1] = c[1];
    rgba[o + 2] = c[2];
    rgba[o + 3] = Math.round(255 * a);
  };
  const mode = style.mode ?? 'contours';
  const outlines = mode === 'contours' || mode === 'both';
  let sel: CellShape | null = null;
  if (mode === 'footprints' || mode === 'both') {
    // Full extent: where footprints overlap, the one brighter there (relative
    // to its own peak) shows.
    for (const shape of g.shapes) {
      if (shape.id === style.selected) continue;
      const c = style.color(shape.id);
      const { support, rel } = shape;
      for (let k = 0; k < support.length; k++) {
        const a = Math.round(255 * FOOTPRINT_ALPHA * Math.min(1, rel[k]));
        const o = support[k] * 4;
        if (a > rgba[o + 3]) {
          rgba[o] = c[0];
          rgba[o + 1] = c[1];
          rgba[o + 2] = c[2];
          rgba[o + 3] = a;
        }
      }
    }
  }
  for (const shape of g.shapes) {
    if (shape.id === style.selected) {
      sel = shape;
      continue;
    }
    if (!outlines) continue;
    const c = style.color(shape.id);
    const f = style.fill(shape.id);
    if (f > 0) for (const p of shape.inside) put(p, c, f);
    for (const p of shape.contour) put(p, c, 0.95);
  }
  // The selected cell on top.
  if (sel) {
    for (const p of sel.inside) put(p, SELECTED, 0.3);
    for (const p of sel.contour) put(p, SELECTED, 1);
  }
  return rgba;
}
