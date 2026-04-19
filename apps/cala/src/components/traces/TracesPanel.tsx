import { createEffect, createSignal, onCleanup, type JSX } from 'solid-js';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import {
  createArchiveClient,
  type ArchiveClient,
  type AllTracesReply,
} from '../../lib/archive-client.ts';
import { currentArchiveWorkerForClient } from '../../lib/run-control.ts';
import { state } from '../../lib/data-store.ts';
import { setSelectedNeuronId } from '../../lib/selection-store.ts';

// Poll cadence for the traces strip chart. Matches the archive
// dump polling cadence so the chart lags reality by at most one
// interval on either side.
const DEFAULT_TRACES_POLL_INTERVAL_MS = 1000;
// Chart canvas size (uPlot requires explicit dims). Actual CSS
// governs visual size via the wrapper; this is the pixel density.
const DEFAULT_CHART_WIDTH_PX = 640;
const DEFAULT_CHART_HEIGHT_PX = 260;
// Line width + alpha. Strip chart gets busy at ~200 lines so thin
// strokes with transparency keep individual traces legible without
// a heavy UI stroke-per-line cost.
const TRACE_STROKE_WIDTH = 1;
const TRACE_STROKE_ALPHA = 0.6;

interface TracesPollerHandle {
  stop: () => void;
}

function startTracesPolling(
  client: ArchiveClient,
  onReply: (reply: AllTracesReply) => void,
  intervalMs: number,
): TracesPollerHandle {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const tick = (): void => {
    if (stopped) return;
    client
      .requestAllTraces()
      .then((reply) => {
        if (stopped) return;
        onReply(reply);
      })
      .catch(() => {
        // Polling soft-fails — chart is cosmetic. Next tick retries.
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

/**
 * Per-id color via a stable hue hash so a given neuron keeps its
 * color across polls. HSL with mid saturation + luminance so no
 * line disappears on the dark dashboard background.
 */
function colorForId(id: number): string {
  const hue = (id * 137.508) % 360;
  return `hsla(${hue.toFixed(0)}, 70%, 60%, ${TRACE_STROKE_ALPHA})`;
}

/**
 * Merge per-id (times, values) parallel arrays into uPlot's data
 * shape: one shared X axis, one Y array per series padded with
 * `null` where that id had no sample.
 */
function buildPlotData(reply: AllTracesReply): {
  data: uPlot.AlignedData;
  seriesConfig: uPlot.Series[];
} {
  if (reply.ids.length === 0) {
    return {
      data: [new Float64Array(0)] as unknown as uPlot.AlignedData,
      seriesConfig: [{}],
    };
  }
  // Union of all timestamps across ids — the x-axis.
  const tsSet = new Set<number>();
  for (const ts of reply.times) {
    for (let i = 0; i < ts.length; i += 1) tsSet.add(ts[i]);
  }
  const allTs = Array.from(tsSet).sort((a, b) => a - b);
  // Per-id lookup for O(1) (t → value) alignment.
  const series: (number | null)[][] = [];
  for (let k = 0; k < reply.ids.length; k += 1) {
    const idx = new Map<number, number>();
    const ts = reply.times[k];
    const vs = reply.values[k];
    for (let j = 0; j < ts.length; j += 1) idx.set(ts[j], vs[j]);
    const col: (number | null)[] = new Array(allTs.length);
    for (let i = 0; i < allTs.length; i += 1) {
      col[i] = idx.has(allTs[i]) ? (idx.get(allTs[i]) as number) : null;
    }
    series.push(col);
  }
  const data: uPlot.AlignedData = [allTs, ...series] as unknown as uPlot.AlignedData;
  const seriesConfig: uPlot.Series[] = [
    { label: 't' },
    ...Array.from(reply.ids).map((id) => ({
      label: `#${id}`,
      stroke: colorForId(id),
      width: TRACE_STROKE_WIDTH,
      spanGaps: false,
    })),
  ];
  return { data, seriesConfig };
}

export function TracesPanel(): JSX.Element {
  let wrapRef: HTMLDivElement | undefined;
  let plot: uPlot | null = null;
  const [client, setClient] = createSignal<ArchiveClient | null>(null);
  let poller: TracesPollerHandle | null = null;
  // Keep ids in the order uPlot's series array saw them so a click
  // on series index i resolves back to the right neuron id.
  let seriesIds: number[] = [];

  const renderPlot = (reply: AllTracesReply): void => {
    if (!wrapRef) return;
    const { data, seriesConfig } = buildPlotData(reply);
    seriesIds = Array.from(reply.ids);
    if (plot) {
      plot.destroy();
      plot = null;
    }
    const opts: uPlot.Options = {
      width: DEFAULT_CHART_WIDTH_PX,
      height: DEFAULT_CHART_HEIGHT_PX,
      series: seriesConfig,
      legend: { show: false },
      scales: { x: { time: false } },
      axes: [{ label: 'frame' }, { label: 'c̃' }],
      hooks: {
        // Click on the plot — map the nearest point back to the
        // selected series index, then to the neuron id. uPlot's
        // `series` index 0 is the x-axis, so subtract 1.
        setSeries: [
          (_self, seriesIdx): void => {
            if (seriesIdx === null || seriesIdx <= 0) return;
            const id = seriesIds[seriesIdx - 1];
            if (id !== undefined) setSelectedNeuronId(id);
          },
        ],
      },
    };
    plot = new uPlot(opts, data, wrapRef);
  };

  createEffect(() => {
    const rs = state.runState;
    if (rs === 'running') {
      const worker = currentArchiveWorkerForClient();
      if (!worker) return;
      const c = createArchiveClient(worker);
      setClient(c);
      poller = startTracesPolling(c, renderPlot, DEFAULT_TRACES_POLL_INTERVAL_MS);
    } else {
      poller?.stop();
      poller = null;
      const c = client();
      c?.dispose();
      setClient(null);
      if (plot) {
        plot.destroy();
        plot = null;
      }
    }
  });

  onCleanup(() => {
    poller?.stop();
    client()?.dispose();
    if (plot) plot.destroy();
  });

  return (
    <div class="traces-panel">
      <div class="traces-panel__header">traces</div>
      <div ref={wrapRef} class="traces-panel__chart" />
    </div>
  );
}
