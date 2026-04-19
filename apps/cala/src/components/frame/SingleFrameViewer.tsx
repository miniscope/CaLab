import { createEffect, createMemo, createSignal, For, onCleanup, Show, type JSX } from 'solid-js';
import { DashboardPanel } from '@calab/ui';
import type { PipelineEvent } from '@calab/cala-runtime';
import { dashboard } from '../../lib/dashboard-store.ts';
import { latestFrame } from '../../lib/run-control.ts';
import { writeGrayscaleToImageData } from '../../lib/frame-preview.ts';

// Trailing window of events shown in the side panel's feed. Design
// §8 event feed; §11 dashboard. The archive worker retains the full
// ring — this is just the visible tail.
const EVENT_TAIL_LENGTH = 20;
// Trailing metric keys shown in the 1-line summary. Kept small so
// whatever W4 produces stays legible; overflow is counted, not listed.
const METRIC_SUMMARY_MAX_KEYS = 3;

function describeEvent(e: PipelineEvent): string {
  switch (e.kind) {
    case 'birth':
      return `birth id=${e.id}`;
    case 'merge':
      return `merge ${e.ids.join('+')} → ${e.into}`;
    case 'split':
      return `split ${e.from} → [${e.into.join(',')}]`;
    case 'deprecate':
      return `deprecate id=${e.id} (${e.reason})`;
    case 'reject':
      return `reject @(${e.at[0]},${e.at[1]}): ${e.reason}`;
    case 'metric':
      return `metric ${e.name}=${e.value.toFixed(3)}`;
    case 'footprint-snapshot':
      return `footprint-snap id=${e.neuronId} (${e.footprint.pixelIndices.length}px)`;
  }
}

function metricSummary(metrics: Record<string, number>): string {
  const entries = Object.entries(metrics);
  if (entries.length === 0) return 'no metrics yet';
  const shown = entries.slice(0, METRIC_SUMMARY_MAX_KEYS);
  const parts = shown.map(([k, v]) => `${k}: ${v.toFixed(2)}`);
  if (entries.length > METRIC_SUMMARY_MAX_KEYS) {
    parts.push(`(+${entries.length - METRIC_SUMMARY_MAX_KEYS} more)`);
  }
  return parts.join(' | ');
}

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

  const eventTail = createMemo(() => {
    const events = dashboard.events;
    const start = Math.max(0, events.length - EVENT_TAIL_LENGTH);
    // Newest first — reverse after slicing so we don't mutate store state.
    return events.slice(start).slice().reverse();
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
      <DashboardPanel id="frame-viewer-side" variant="data" class="frame-viewer__side">
        <div class="frame-viewer__stat frame-viewer__stat--frame">{frameLabel()}</div>
        <div class="frame-viewer__stat frame-viewer__stat--metrics">
          {metricSummary(dashboard.metrics)}
        </div>
        <div class="frame-viewer__events">
          <div class="frame-viewer__events-heading">Events (newest first)</div>
          <Show
            when={eventTail().length > 0}
            fallback={<div class="frame-viewer__events-empty">No events yet.</div>}
          >
            <ul class="frame-viewer__events-list">
              <For each={eventTail()}>
                {(e) => (
                  <li class="frame-viewer__events-item">
                    <span class="frame-viewer__events-kind">{e.kind}</span>
                    <span class="frame-viewer__events-detail">{describeEvent(e)}</span>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>
      </DashboardPanel>
    </div>
  );
}
