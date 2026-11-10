import { createEffect, type JSX } from 'solid-js';
import { grayToImageData, toGray8 } from '../lib/frame-display.ts';
import type { PreviewImage } from '../lib/preview.ts';
import { createHeldRange, type HeldRange } from './RangeControl.tsx';

/**
 * Draws a float preview image with a fixed display range (see `RangeHold`):
 * fitted once from the first images, then held. Never auto-contrast.
 */
export function PreviewCanvas(props: {
  image: PreviewImage | null;
  label: string;
  held?: HeldRange;
}): JSX.Element {
  let canvas!: HTMLCanvasElement;
  // eslint-disable-next-line solid/reactivity
  const held = props.held ?? createHeldRange();
  let shown = '';

  createEffect(() => {
    const img = props.image;
    held.revision();
    // A different view has a different intensity domain: fit afresh.
    if (props.label !== shown) held.reset();
    shown = props.label;
    const ctx = canvas.getContext('2d');
    if (!img) {
      held.reset();
      return;
    }
    if (!ctx) return;
    const range = held.observe(img.data);
    if (!range) return;
    if (canvas.width !== img.width) canvas.width = img.width;
    if (canvas.height !== img.height) canvas.height = img.height;
    ctx.putImageData(grayToImageData(toGray8(img.data, 0, range), img.width, img.height), 0, 0);
  });

  return <canvas ref={canvas} class="cala-preview" aria-label={props.label} />;
}
