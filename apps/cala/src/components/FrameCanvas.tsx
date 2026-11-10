import { createEffect, type JSX } from 'solid-js';
import { displayRange, grayToImageData, toGray8 } from '../lib/frame-display.ts';
import { createHeldRange, type HeldRange } from './RangeControl.tsx';
import type { CurrentFrame } from '../lib/viewer-store.ts';

interface FrameCanvasProps {
  width: number;
  height: number;
  bitDepth: number;
  frame: CurrentFrame | null;
  /** Fit a fixed range once from the first frames and hold it; off = full scale. */
  autoContrast: boolean;
  held?: HeldRange;
}

/** Draws one decoded grayscale frame at native resolution; CSS scales it to fit. */
export function FrameCanvas(props: FrameCanvasProps): JSX.Element {
  let canvas!: HTMLCanvasElement;
  // eslint-disable-next-line solid/reactivity
  const held = props.held ?? createHeldRange();

  createEffect(() => {
    const f = props.frame;
    held.revision();
    const w = props.width;
    const h = props.height;
    const ctx = canvas.getContext('2d');
    if (!f) held.reset();
    if (!f || !ctx) return;
    const range = props.autoContrast
      ? held.observe(f.pixels)
      : displayRange(f.pixels, props.bitDepth, false);
    if (!range) return;
    const gray = toGray8(f.pixels, props.bitDepth, range);
    if (gray.length !== w * h) return;
    ctx.putImageData(grayToImageData(gray, w, h), 0, 0);
  });

  return (
    <canvas
      ref={canvas}
      class="cala-canvas"
      width={props.width}
      height={props.height}
      aria-label="Current video frame"
      data-testid="frame-canvas"
    />
  );
}
