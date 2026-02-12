/**
 * Auto-fill grid container for CellCards.
 * Reads from multiCellResults and renders a card for each selected cell.
 * Only scrollable area in the dashboard.
 *
 * Uses selectedCells() (stable number primitives) as the <For> source
 * so that SolidJS can match items by value across solver updates,
 * keeping CellCard instances alive and preserving their zoom state.
 */

import { For, Show, createMemo } from 'solid-js';
import { CellCard } from './CellCard';
import {
  selectedCells,
  multiCellResults,
  solvingCells,
  activelySolvingCell,
  gridColumns,
} from '../../lib/multi-cell-store';
import { samplingRate } from '../../lib/data-store';
import { selectedCell } from '../../lib/viz-store';
import '../../styles/cards.css';

export interface CardGridProps {
  onCellClick: (cellIndex: number) => void;
}

export function CardGrid(props: CardGridProps) {
  const cells = createMemo(() => selectedCells());

  return (
    <div class="card-grid-container">
      <Show
        when={cells().length > 0}
        fallback={
          <div class="card-grid__empty">
            No cell results yet. Adjust parameters to solve.
          </div>
        }
      >
        <div class="card-grid" style={{ '--grid-cols': gridColumns() }}>
          <For each={cells()}>
            {(cellIndex) => {
              const traces = createMemo(() => multiCellResults().get(cellIndex));
              return (
                <Show when={traces()}>
                  {(t) => (
                    <CellCard
                      cellIndex={cellIndex}
                      rawTrace={t().raw}
                      deconvolvedTrace={t().deconvolved}
                      reconvolutionTrace={t().reconvolution}
                      samplingRate={samplingRate() ?? 30}
                      isActive={selectedCell() === cellIndex}
                      solverStatus={
                        activelySolvingCell() === cellIndex ? 'solving'
                          : solvingCells().has(cellIndex) ? 'stale'
                          : 'fresh'
                      }
                      onClick={() => props.onCellClick(cellIndex)}
                    />
                  )}
                </Show>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
}
