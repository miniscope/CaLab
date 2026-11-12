/**
 * Zoom and pan of the field-of-view viewer, in normalized image coordinates.
 * Pure, so it is unit-tested without a DOM.
 *
 * The stage box always has the recording's aspect ratio, and at zoom 1 the
 * image fills it ("Fit"). `zoom` scales that fitted image; `(u, v)` is the
 * image point (0..1 of width and height) at the centre of the stage. The
 * view never leaves the image: at zoom `z` the visible span is `1 / z`, so
 * the centre stays within `[0.5 / z, 1 - 0.5 / z]`.
 */

export interface FovView {
  zoom: number;
  u: number;
  v: number;
}

export const FIT_VIEW: FovView = { zoom: 1, u: 0.5, v: 0.5 };

/** Deepest zoom: a recording pixel at most this many fitted pixels wide. */
export const MAX_ZOOM = 32;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export function clampView(view: FovView, maxZoom = MAX_ZOOM): FovView {
  const zoom = clamp(Number.isFinite(view.zoom) ? view.zoom : 1, 1, Math.max(1, maxZoom));
  const half = 0.5 / zoom;
  return {
    zoom,
    u: clamp(Number.isFinite(view.u) ? view.u : 0.5, half, 1 - half),
    v: clamp(Number.isFinite(view.v) ? view.v : 0.5, half, 1 - half),
  };
}

/** Image point (normalized) under stage position `(px, py)` (0..1 of the stage). */
export function imageAt(view: FovView, px: number, py: number): [number, number] {
  return [view.u + (px - 0.5) / view.zoom, view.v + (py - 0.5) / view.zoom];
}

/**
 * Zoom by `factor` keeping the image point under stage position `(px, py)`
 * where it is (the cursor for the wheel, the centre for the buttons).
 */
export function zoomAt(
  view: FovView,
  factor: number,
  px = 0.5,
  py = 0.5,
  maxZoom = MAX_ZOOM,
): FovView {
  const [ix, iy] = imageAt(view, px, py);
  const zoom = clamp(view.zoom * factor, 1, Math.max(1, maxZoom));
  return clampView({ zoom, u: ix - (px - 0.5) / zoom, v: iy - (py - 0.5) / zoom }, maxZoom);
}

/** Pan by a drag of `(dx, dy)` stage fractions (the image follows the pointer). */
export function panBy(view: FovView, dx: number, dy: number, maxZoom = MAX_ZOOM): FovView {
  return clampView({ ...view, u: view.u - dx / view.zoom, v: view.v - dy / view.zoom }, maxZoom);
}

/** Centre the view on image point `(u, v)` (a minimap click). */
export function centreOn(view: FovView, u: number, v: number, maxZoom = MAX_ZOOM): FovView {
  return clampView({ ...view, u, v }, maxZoom);
}

/**
 * Zoom at which one recording pixel takes one CSS pixel ("1:1"), for an
 * image `imageWidth` px wide fitted into `stageWidth` CSS px.
 */
export function oneToOneZoom(imageWidth: number, stageWidth: number): number {
  return stageWidth > 0 && imageWidth > 0 ? imageWidth / stageWidth : 1;
}

/**
 * CSS transform of the image layer (transform-origin top left, the layer
 * sized to the stage): scale by `zoom`, then move `(u, v)` to the centre.
 * Translate percentages are of the layer's own size.
 */
export function viewTransform(view: FovView): string {
  const tx = (0.5 - view.u * view.zoom) * 100;
  const ty = (0.5 - view.v * view.zoom) * 100;
  return `translate(${tx.toFixed(4)}%, ${ty.toFixed(4)}%) scale(${view.zoom.toFixed(5)})`;
}

/** The visible part of the image, normalized: `[x0, y0, width, height]` (minimap box). */
export function visibleRect(view: FovView): [number, number, number, number] {
  const s = 1 / view.zoom;
  return [view.u - s / 2, view.v - s / 2, s, s];
}
