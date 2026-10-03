import { createMemo, createSignal, For, type JSX } from 'solid-js';
import { DashboardPanel } from '@calab/ui';
import { TraceOverview } from '@calab/ui/chart';
import { extractCellTrace, type ImportStore } from '@calab/io';

/** Placeholder result view: pick a cell and draw its whole trace. Replace with your analysis. */
export function TraceView(props: { store: ImportStore }): JSX.Element {
  const [cell, setCell] = createSignal(0);
  const [zoom, setZoom] = createSignal<[number, number]>([0, 30]);

  const trace = createMemo(() => {
    const data = props.store.parsedData();
    const shape = props.store.effectiveShape();
    if (!data || !shape) return new Float64Array(0);
    return extractCellTrace(Math.min(cell(), shape[0] - 1), data, shape, props.store.swapped());
  });

  return (
    <DashboardPanel id="trace" variant="data">
      <label class="panel-label">
        Cell{' '}
        <select value={cell()} onChange={(e) => setCell(Number(e.currentTarget.value))}>
          <For each={Array.from({ length: props.store.numCells() }, (_, i) => i)}>
            {(i) => <option value={i}>{i + 1}</option>}
          </For>
        </select>{' '}
        of {props.store.numCells()}
      </label>
      <TraceOverview
        trace={trace()}
        samplingRate={props.store.samplingRate() ?? 1}
        zoomStart={zoom()[0]}
        zoomEnd={zoom()[1]}
        onZoomChange={(start, end) => setZoom([start, end])}
      />
    </DashboardPanel>
  );
}
