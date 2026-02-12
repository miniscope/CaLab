/**
 * Compact mini-panel grid for displaying multi-cell solver results.
 * Each mini-panel shows raw + fit overlay for a selected cell.
 * Clicking a mini-panel switches that cell to the primary trace view.
 */

import { For, Show, createMemo } from 'solid-js';

import { TracePanel } from './TracePanel';

import { downsampleMinMax } from '../../lib/chart/downsample';
import { makeTimeAxis } from '../../lib/chart/time-axis';
import { createRawSeries, createFitSeries } from '../../lib/chart/series-config';
import { multiCellResults } from '../../lib/multi-cell-store';
import { samplingRate } from '../../lib/data-store';
import { selectedCell } from '../../lib/viz-store';

import '../../styles/multi-trace.css';

export interface MultiTraceViewProps {
  /** Called when user clicks a mini-panel to switch the primary cell. */
  onCellClick: (cellIndex: number) => void;
}

const MINI_BUCKET_WIDTH = 600;
const SYNC_KEY = 'catune-multi';

export function MultiTraceView(props: MultiTraceViewProps) {
  const entries = createMemo(() => [...multiCellResults().entries()]);

  return (
    <Show when={multiCellResults().size > 0}>
      <section class="multi-trace-section" data-tutorial="multi-trace-view">
        <div class="multi-trace-header">
          <h3 class="multi-trace-header__title">Multi-Cell Comparison</h3>
          <span class="multi-trace-header__count">
            {multiCellResults().size} cells
          </span>
        </div>

        <div class="multi-trace-grid">
          <For each={entries()}>
            {([cellIndex, traces]) => {
              const data = createMemo<[number[], ...number[][]]>(() => {
                const x = makeTimeAxis(traces.raw.length, samplingRate() ?? 30);

                const [dsX, dsRaw] = downsampleMinMax(
                  x,
                  traces.raw,
                  MINI_BUCKET_WIDTH,
                );
                const [, dsFit] = downsampleMinMax(
                  x,
                  traces.reconvolution,
                  MINI_BUCKET_WIDTH,
                );

                return [dsX, dsRaw, dsFit];
              });

              const isActive = () => selectedCell() === cellIndex;

              return (
                <div
                  class={`mini-panel ${isActive() ? 'mini-panel--active' : ''}`}
                  onClick={() => props.onCellClick(cellIndex)}
                >
                  <div class="mini-panel__label">Cell {cellIndex + 1}</div>
                  <TracePanel
                    data={() => data()}
                    series={[{}, createRawSeries(), createFitSeries()]}
                    height={80}
                    syncKey={SYNC_KEY}
                  />
                </div>
              );
            }}
          </For>
        </div>
      </section>
    </Show>
  );
}
