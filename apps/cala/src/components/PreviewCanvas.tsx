import { createEffect, type JSX } from 'solid-js';
import { displayRange, grayToImageData, toGray8, type DisplayRange } from '../lib/frame-display.ts';
import type { PreviewImage } from '../lib/preview.ts';

/** Weight of the newest frame in the smoothed contrast range (less flicker). */
const RANGE_SMOOTHING = 0.3;

/** Draws a float preview image with auto contrast smoothed over time. */
export function PreviewCanvas(props: { image: PreviewImage | null; label: string }): JSX.Element {
  let canvas!: HTMLCanvasElement;
  let range: DisplayRange | null = null;
  let shown = '';

  createEffect(() => {
    const img = props.image;
    // A different view has a different intensity domain: start the range afresh.
    if (props.label !== shown) range = null;
    shown = props.label;
    const ctx = canvas.getContext('2d');
    if (!img || !ctx) return;
    const r = displayRange(img.data, 0, true);
    range = range
      ? {
          lo: range.lo + RANGE_SMOOTHING * (r.lo - range.lo),
          hi: range.hi + RANGE_SMOOTHING * (r.hi - range.hi),
        }
      : r;
    if (canvas.width !== img.width) canvas.width = img.width;
    if (canvas.height !== img.height) canvas.height = img.height;
    ctx.putImageData(grayToImageData(toGray8(img.data, 0, range), img.width, img.height), 0, 0);
  });

  return <canvas ref={canvas} class="cala-preview" aria-label={props.label} />;
}
