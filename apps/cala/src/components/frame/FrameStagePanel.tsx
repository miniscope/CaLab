import { createEffect, createSignal, Show, type JSX } from 'solid-js';
import { latestFrames, type FrameStage, type LatestFramePreview } from '../../lib/run-control.ts';
import { writeGrayscaleToImageData } from '../../lib/frame-preview.ts';

interface FrameStagePanelProps {
  stage: FrameStage;
  label: string;
}

/**
 * One canvas of the 4-canvas frame panel (design §8, Phase 7 task 7).
 * Reads the `latestFrames` signal keyed by `stage` and blits the u8
 * preview into a pre-allocated `ImageData`. Structurally identical to
 * `SingleFrameViewer` but scoped to one stage so the quad can compose
 * four of them.
 */
export function FrameStagePanel(props: FrameStagePanelProps): JSX.Element {
  let canvasRef: HTMLCanvasElement | undefined;
  const [imageData, setImageData] = createSignal<ImageData | null>(null);
  const [canvasDims, setCanvasDims] = createSignal<{ width: number; height: number } | null>(null);

  const frame = (): LatestFramePreview | undefined => latestFrames()[props.stage];

  createEffect(() => {
    const f = frame();
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

  createEffect(() => {
    const f = frame();
    const img = imageData();
    const canvas = canvasRef;
    if (!f || !img || !canvas) return;
    if (img.width !== f.width || img.height !== f.height) return;
    writeGrayscaleToImageData(f.pixels, img);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.putImageData(img, 0, 0);
  });

  return (
    <div class="frame-stage">
      <div class="frame-stage__label">{props.label}</div>
      <div class="frame-stage__canvas-wrap">
        <canvas
          ref={canvasRef}
          class="frame-stage__canvas"
          width={1}
          height={1}
          aria-label={`${props.label} frame`}
        />
        <Show when={!frame()}>
          <div class="frame-stage__placeholder">awaiting…</div>
        </Show>
      </div>
    </div>
  );
}
