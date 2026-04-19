import { createEffect, createSignal, onCleanup, type JSX } from 'solid-js';
import {
  createArchiveClient,
  type ArchiveClient,
  type AllFootprintsReply,
} from '../../lib/archive-client.ts';
import { currentArchiveWorkerForClient } from '../../lib/run-control.ts';
import { state } from '../../lib/data-store.ts';
import { maxProjection } from '../../lib/max-projection-store.ts';
import { setSelectedNeuronId, selectedNeuronId } from '../../lib/selection-store.ts';

// Poll cadence for the footprints query. Footprints change at
// mutation-apply cadence (extend cycle = ~1 Hz on the default
// 32-frame stride), so polling faster than that is wasted work.
const DEFAULT_FOOTPRINTS_POLL_INTERVAL_MS = 1000;
// Fraction of a footprint's peak weight a pixel must have to count
// as "interior" for the overlay outline. Matches extend's default
// `footprint_support_threshold_rel` so the drawn boundary lines up
// with the component's effective support.
const DEFAULT_BOUNDARY_THRESHOLD_REL = 0.1;
// Stroke width for the overlay outline. 1px keeps overlap pileup
// readable at 248 neurons; thicker strokes visually merge outlines.
const OVERLAY_STROKE_WIDTH = 1;

interface FootprintsPollerHandle {
  stop: () => void;
}

function startFootprintsPolling(
  client: ArchiveClient,
  onReply: (reply: AllFootprintsReply) => void,
  intervalMs: number,
): FootprintsPollerHandle {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const tick = (): void => {
    if (stopped) return;
    client
      .requestAllFootprints()
      .then((reply) => {
        if (stopped) return;
        onReply(reply);
      })
      .catch(() => {
        // Cosmetic — next tick retries.
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

function colorForId(id: number): string {
  const hue = (id * 137.508) % 360;
  return `hsl(${hue.toFixed(0)}, 70%, 60%)`;
}

/**
 * Draw `maxProj` into the canvas as grayscale, then overlay each
 * footprint's boundary in its per-id color. Re-runs on poll + on
 * max-projection update + on selection change.
 */
function renderPanel(
  canvas: HTMLCanvasElement,
  proj: { width: number; height: number; pixels: Uint8ClampedArray } | null,
  footprints: AllFootprintsReply,
  selectedId: number | null,
): void {
  if (!proj) {
    canvas.width = 1;
    canvas.height = 1;
    return;
  }
  if (canvas.width !== proj.width || canvas.height !== proj.height) {
    canvas.width = proj.width;
    canvas.height = proj.height;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  // Base layer: grayscale max projection.
  const img = ctx.createImageData(proj.width, proj.height);
  for (let i = 0; i < proj.pixels.length; i += 1) {
    const v = proj.pixels[i];
    const j = i * 4;
    img.data[j] = v;
    img.data[j + 1] = v;
    img.data[j + 2] = v;
    img.data[j + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);

  // Overlay: per-id boundary in color. Compute interior mask, then
  // stroke any interior pixel with a non-interior 4-connected
  // neighbor. Cheap because supports are sparse.
  for (let k = 0; k < footprints.ids.length; k += 1) {
    const id = footprints.ids[k];
    const support = footprints.pixelIndices[k];
    const values = footprints.values[k];
    if (support.length === 0) continue;

    // Peak weight for this footprint — threshold applies relative.
    let peak = 0;
    for (let i = 0; i < values.length; i += 1) {
      if (values[i] > peak) peak = values[i];
    }
    const cutoff = peak * DEFAULT_BOUNDARY_THRESHOLD_REL;

    // Build a small Set of linear indices belonging to the interior
    // for O(1) neighbor checks.
    const interior = new Set<number>();
    for (let i = 0; i < support.length; i += 1) {
      if (values[i] >= cutoff) interior.add(support[i]);
    }
    if (interior.size === 0) continue;

    const isSelected = selectedId !== null && selectedId === id;
    ctx.fillStyle = colorForId(id);
    ctx.strokeStyle = isSelected ? 'white' : colorForId(id);
    ctx.lineWidth = isSelected ? OVERLAY_STROKE_WIDTH + 1 : OVERLAY_STROKE_WIDTH;

    for (const idx of interior) {
      const y = Math.floor(idx / proj.width);
      const x = idx - y * proj.width;
      // 4-connected boundary: if any cardinal neighbor is outside
      // the interior, this pixel is an outline pixel.
      const neighbors = [
        x > 0 ? idx - 1 : -1,
        x < proj.width - 1 ? idx + 1 : -1,
        y > 0 ? idx - proj.width : -1,
        y < proj.height - 1 ? idx + proj.width : -1,
      ];
      let onBoundary = false;
      for (const n of neighbors) {
        if (n < 0 || !interior.has(n)) {
          onBoundary = true;
          break;
        }
      }
      if (onBoundary) {
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }
}

export function FootprintsPanel(): JSX.Element {
  let canvasRef: HTMLCanvasElement | undefined;
  const [client, setClient] = createSignal<ArchiveClient | null>(null);
  const [reply, setReply] = createSignal<AllFootprintsReply>({
    ids: new Uint32Array(0),
    pixelIndices: [],
    values: [],
  });
  let poller: FootprintsPollerHandle | null = null;

  // Map canvas click → nearest footprint → selectedNeuronId. Uses
  // a point-in-support test: the first footprint whose sparse
  // support contains the clicked pixel wins.
  const onCanvasClick = (ev: MouseEvent): void => {
    const canvas = canvasRef;
    if (!canvas) return;
    const proj = maxProjection();
    if (!proj) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = Math.floor((ev.clientX - rect.left) * scaleX);
    const y = Math.floor((ev.clientY - rect.top) * scaleY);
    if (x < 0 || y < 0 || x >= proj.width || y >= proj.height) return;
    const idx = y * proj.width + x;
    const r = reply();
    for (let k = 0; k < r.ids.length; k += 1) {
      const support = r.pixelIndices[k];
      for (let i = 0; i < support.length; i += 1) {
        if (support[i] === idx) {
          setSelectedNeuronId(r.ids[k]);
          return;
        }
      }
    }
    setSelectedNeuronId(null);
  };

  createEffect(() => {
    const canvas = canvasRef;
    if (!canvas) return;
    renderPanel(canvas, maxProjection(), reply(), selectedNeuronId());
  });

  createEffect(() => {
    const rs = state.runState;
    if (rs === 'running') {
      const worker = currentArchiveWorkerForClient();
      if (!worker) return;
      const c = createArchiveClient(worker);
      setClient(c);
      poller = startFootprintsPolling(c, setReply, DEFAULT_FOOTPRINTS_POLL_INTERVAL_MS);
    } else {
      poller?.stop();
      poller = null;
      const c = client();
      c?.dispose();
      setClient(null);
      setReply({ ids: new Uint32Array(0), pixelIndices: [], values: [] });
    }
  });

  onCleanup(() => {
    poller?.stop();
    client()?.dispose();
  });

  return (
    <div class="footprints-panel">
      <div class="footprints-panel__header">footprints over max-projection</div>
      <div class="footprints-panel__canvas-wrap">
        <canvas
          ref={canvasRef}
          class="footprints-panel__canvas"
          width={1}
          height={1}
          onClick={onCanvasClick}
          aria-label="Footprints overlay"
        />
      </div>
    </div>
  );
}
