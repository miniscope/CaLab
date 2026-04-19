import { createEffect, createSignal, onCleanup, Show, type JSX } from 'solid-js';
import { dashboard } from '../../lib/dashboard-store.ts';
import { latestFrame } from '../../lib/run-control.ts';
import { writeGrayscaleToImageData } from '../../lib/frame-preview.ts';

export function SingleFrameViewer(): JSX.Element {
  let canvasRef: HTMLCanvasElement | undefined;
  const [imageData, setImageData] = createSignal<ImageData | null>(null);
  const [canvasDims, setCanvasDims] = createSignal<{ width: number; height: number } | null>(null);

  // Pre-allocate ImageData whenever the frame dimensions change. The
  // viewer hot path reuses this buffer — allocation only happens on
  // dim change, which in practice is once per run.
  createEffect(() => {
    const f = latestFrame();
    if (!f) return;
    const dims = canvasDims();
    if (!dims || dims.width !== f.width || dims.height !== f.height) {
      const canvas = canvasRef;
      if (!canvas) return;
      canvas.width = f.width;
      canvas.height = f.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      setImageData(ctx.createImageData(f.width, f.height));
      setCanvasDims({ width: f.width, height: f.height });
    }
  });

  // Render pass: copy the latest u8 frame into the pre-allocated
  // ImageData and blit with putImageData. Pure DOM work — no solid
  // reactivity inside the hot loop.
  createEffect(() => {
    const f = latestFrame();
    const img = imageData();
    const canvas = canvasRef;
    if (!f || !img || !canvas) return;
    if (img.width !== f.width || img.height !== f.height) return;
    writeGrayscaleToImageData(f.pixels, img);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.putImageData(img, 0, 0);
  });

  onCleanup(() => {
    setImageData(null);
    setCanvasDims(null);
  });

  const frameLabel = (): string => {
    const idx = dashboard.currentFrameIndex;
    const ep = dashboard.currentEpoch;
    if (idx === null || ep === null) return 'awaiting frames…';
    return `frame ${idx} · epoch ${ep.toString()}`;
  };

  return (
    <div class="frame-viewer">
      <div class="frame-viewer__canvas-wrap">
        <canvas
          ref={canvasRef}
          class="frame-viewer__canvas"
          width={1}
          height={1}
          aria-label="Latest preprocessed frame"
        />
        <Show when={!latestFrame()}>
          <div class="frame-viewer__placeholder">Awaiting first preview frame…</div>
        </Show>
      </div>
      <div class="frame-viewer__label">{frameLabel()}</div>
    </div>
  );
}
