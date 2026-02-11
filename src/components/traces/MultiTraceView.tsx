/**
 * Compact mini-panel grid for displaying multi-cell solver results.
 * Each mini-panel shows raw + fit overlay for a selected cell.
 * Clicking a mini-panel switches that cell to the primary trace view.
 */

import { For, Show, createMemo } from 'solid-js';
import { TracePanel } from './TracePanel';
import { downsampleMinMax } from '../../lib/chart/downsample';
import {
  multiCellResults,
  multiCellSolving,
  multiCellProgress,
} from '../../lib/multi-cell-store';
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
      <section class="multi-trace-section">
        <div class="multi-trace-header">
          <h3 class="multi-trace-header__title">Multi-Cell Comparison</h3>
          <span class="multi-trace-header__count">
            {multiCellResults().size} cells
          </span>
        </div>

        <Show when={multiCellSolving()}>
          <div class="solving-progress">
            Solving cell {multiCellProgress()?.current ?? 0} of{' '}
            {multiCellProgress()?.total ?? 0}...
          </div>
        </Show>

        <div class="multi-trace-grid">
          <For each={entries()}>
            {([cellIndex, traces]) => {
              const data = createMemo<[number[], ...number[][]]>(() => {
                const fs = samplingRate() ?? 30;
                const dt = 1 / fs;
                const len = traces.raw.length;
                const x = new Float64Array(len);
                for (let i = 0; i < len; i++) {
                  x[i] = i * dt;
                }

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
                    series={[
                      {},
                      {
                        label: 'Raw',
                        stroke: 'hsl(200, 60%, 50%)',
                        width: 1,
                      },
                      {
                        label: 'Fit',
                        stroke: 'hsl(30, 90%, 60%)',
                        width: 1,
                      },
                    ]}
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
