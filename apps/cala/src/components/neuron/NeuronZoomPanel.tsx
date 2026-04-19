import { createEffect, createSignal, onCleanup, Show, type JSX } from 'solid-js';
import {
  createArchiveClient,
  type ArchiveClient,
  type AllTracesReply,
  type FootprintHistoryEntry,
} from '../../lib/archive-client.ts';
import { currentArchiveWorkerForClient } from '../../lib/run-control.ts';
import { state } from '../../lib/data-store.ts';
import { selectedNeuronId, setSelectedNeuronId } from '../../lib/selection-store.ts';
import { SparkLine } from '../vitals/SparkLine.tsx';

// Poll cadence — this panel is for inspection, not live drilling,
// so a slower tick keeps worker + main-thread overhead low.
const DEFAULT_NEURON_ZOOM_POLL_INTERVAL_MS = 2000;
// Rendered footprint canvas inset (px of padding around the bbox).
const FOOTPRINT_BBOX_PADDING_PX = 2;
// Maximum trace samples to show in the sparkline. Matches the
// traces panel's L1 window so both widgets scroll together.
const DEFAULT_TRACE_WINDOW = 120;

interface PollerHandle {
  stop: () => void;
}

function startNeuronPolling(
  client: ArchiveClient,
  id: number,
  onReply: (data: { footprint: FootprintHistoryEntry | null; trace: Float32Array | null }) => void,
  intervalMs: number,
): PollerHandle {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const idFilter = Uint32Array.of(id);
  const tick = (): void => {
    if (stopped) return;
    Promise.all([client.requestFootprintHistory(id), client.requestAllTraces(idFilter)])
      .then(([footprints, traces]: [FootprintHistoryEntry[], AllTracesReply]) => {
        if (stopped) return;
        const footprint = footprints.length > 0 ? footprints[footprints.length - 1] : null;
        const trace = traces.values.length > 0 ? traces.values[0] : null;
        onReply({ footprint, trace });
      })
      .catch(() => {
        // Cosmetic; next tick retries.
      })
      .finally(() => {
        if (stopped) return;
        timer = setTimeout(tick, intervalMs);
      });
  };
  timer = setTimeout(tick, 0);
  return {
    stop(): void {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

function renderFootprint(
  canvas: HTMLCanvasElement,
  footprint: FootprintHistoryEntry | null,
  frameWidth: number,
): void {
  if (!footprint || footprint.pixelIndices.length === 0) {
    canvas.width = 1;
    canvas.height = 1;
    return;
  }
  // Compute bbox in frame coords from the sparse support.
  let minY = Infinity;
  let maxY = -Infinity;
  let minX = Infinity;
  let maxX = -Infinity;
  for (let i = 0; i < footprint.pixelIndices.length; i += 1) {
    const idx = footprint.pixelIndices[i];
    const y = Math.floor(idx / frameWidth);
    const x = idx - y * frameWidth;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
  }
  const padded = FOOTPRINT_BBOX_PADDING_PX;
  const w = maxX - minX + 1 + padded * 2;
  const h = maxY - minY + 1 + padded * 2;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  // Normalize weights to [0, 1] for rendering.
  let peak = 0;
  for (let i = 0; i < footprint.values.length; i += 1) {
    if (footprint.values[i] > peak) peak = footprint.values[i];
  }
  if (peak <= 0) peak = 1;
  const img = ctx.createImageData(w, h);
  // Fill dark background.
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i + 3] = 255;
  }
  for (let i = 0; i < footprint.pixelIndices.length; i += 1) {
    const idx = footprint.pixelIndices[i];
    const y = Math.floor(idx / frameWidth);
    const x = idx - y * frameWidth;
    const localX = x - minX + padded;
    const localY = y - minY + padded;
    const v = Math.round((footprint.values[i] / peak) * 255);
    const j = (localY * w + localX) * 4;
    img.data[j] = v;
    img.data[j + 1] = v;
    img.data[j + 2] = v;
    img.data[j + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

export function NeuronZoomPanel(): JSX.Element {
  let canvasRef: HTMLCanvasElement | undefined;
  const [client, setClient] = createSignal<ArchiveClient | null>(null);
  const [footprint, setFootprint] = createSignal<FootprintHistoryEntry | null>(null);
  const [trace, setTrace] = createSignal<Float32Array | null>(null);
  let poller: PollerHandle | null = null;
  let frameWidth = 0;

  // Read the frame width from the orchestrator's loaded metadata so
  // `pixelIndex % width` correctly unwraps to (y, x) for the
  // footprint canvas.
  createEffect(() => {
    frameWidth = state.meta?.width ?? 0;
  });

  createEffect(() => {
    const id = selectedNeuronId();
    const rs = state.runState;
    const worker = currentArchiveWorkerForClient();
    // Tear down any previous polling on selection change or run-state flip.
    poller?.stop();
    poller = null;
    client()?.dispose();
    setClient(null);
    setFootprint(null);
    setTrace(null);

    if (id === null || rs !== 'running' || !worker) return;
    const c = createArchiveClient(worker);
    setClient(c);
    poller = startNeuronPolling(
      c,
      id,
      ({ footprint: fp, trace: tr }) => {
        setFootprint(fp);
        setTrace(tr ? tr.slice(-DEFAULT_TRACE_WINDOW) : null);
      },
      DEFAULT_NEURON_ZOOM_POLL_INTERVAL_MS,
    );
  });

  createEffect(() => {
    const canvas = canvasRef;
    if (!canvas) return;
    renderFootprint(canvas, footprint(), frameWidth);
  });

  onCleanup(() => {
    poller?.stop();
    client()?.dispose();
  });

  return (
    <Show when={selectedNeuronId() !== null}>
      <div class="neuron-zoom">
        <div class="neuron-zoom__header">
          <span class="neuron-zoom__id">#{selectedNeuronId()}</span>
          <button
            type="button"
            class="neuron-zoom__close"
            onClick={() => setSelectedNeuronId(null)}
            aria-label="Close neuron zoom"
          >
            ×
          </button>
        </div>
        <div class="neuron-zoom__body">
          <div class="neuron-zoom__footprint-wrap">
            <canvas
              ref={canvasRef}
              class="neuron-zoom__footprint"
              width={1}
              height={1}
              aria-label="Selected neuron footprint"
            />
          </div>
          <div class="neuron-zoom__trace">
            <Show
              when={trace() && trace()!.length > 1}
              fallback={<span class="neuron-zoom__empty">collecting trace…</span>}
            >
              <SparkLine
                values={Array.from(trace() ?? [])}
                title={`neuron-${selectedNeuronId()}`}
              />
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
}
