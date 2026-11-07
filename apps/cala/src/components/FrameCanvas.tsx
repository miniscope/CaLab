import { createEffect, type JSX } from 'solid-js';
import { displayRange, toGray8 } from '../lib/frame-display.ts';
import type { CurrentFrame } from '../lib/viewer-store.ts';

interface FrameCanvasProps {
  width: number;
  height: number;
  bitDepth: number;
  frame: CurrentFrame | null;
  autoContrast: boolean;
}

/** Draws one decoded grayscale frame at native resolution; CSS scales it to fit. */
export function FrameCanvas(props: FrameCanvasProps): JSX.Element {
  let canvas!: HTMLCanvasElement;

  createEffect(() => {
    const f = props.frame;
    const w = props.width;
    const h = props.height;
    const ctx = canvas.getContext('2d');
    if (!f || !ctx) return;
    const gray = toGray8(
      f.pixels,
      props.bitDepth,
      displayRange(f.pixels, props.bitDepth, props.autoContrast),
    );
    if (gray.length !== w * h) return;
    const rgba = new ImageData(w, h);
    for (let i = 0; i < gray.length; i++) {
      const v = gray[i];
      const o = 4 * i;
      rgba.data[o] = v;
      rgba.data[o + 1] = v;
      rgba.data[o + 2] = v;
      rgba.data[o + 3] = 255;
    }
    ctx.putImageData(rgba, 0, 0);
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
