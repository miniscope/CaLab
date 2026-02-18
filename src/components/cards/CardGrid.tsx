/**
 * Auto-fill grid container for CellCards.
 * Reads from multiCellResults and renders a card for each selected cell.
 * Only scrollable area in the dashboard.
 *
 * Uses selectedCells() (stable number primitives) as the <For> source
 * so that SolidJS can match items by value across solver updates,
 * keeping CellCard instances alive and preserving their zoom state.
 */

import { For, Show, createMemo, onMount, onCleanup } from 'solid-js';
import { CellCard } from './CellCard.tsx';
import {
  selectedCells,
  multiCellResults,
  cellSolverStatuses,
  cellIterationCounts,
  gridColumns,
  pinnedMultiCellResults,
  setVisibleCellIndices,
} from '../../lib/multi-cell-store.ts';
import { reportCellZoom } from '../../lib/cell-solve-manager.ts';
import { samplingRate, isDemo, groundTruthVisible, getGroundTruthForCell } from '../../lib/data-store.ts';
import { selectedCell } from '../../lib/viz-store.ts';
import '../../styles/cards.css';

export interface CardGridProps {
  onCellClick: (cellIndex: number) => void;
}

export function CardGrid(props: CardGridProps) {
  const cells = createMemo(() => selectedCells());

  // Track which cards are visible in the viewport via IntersectionObserver
  const visibleSet = new Set<number>();
  const cardRefs = new Map<number, HTMLElement>();
  let observer: IntersectionObserver | undefined;

  onMount(() => {
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const idx = Number((entry.target as HTMLElement).dataset.cellIndex);
          if (isNaN(idx)) continue;
          if (entry.isIntersecting) {
            visibleSet.add(idx);
          } else {
            visibleSet.delete(idx);
          }
        }
        setVisibleCellIndices(new Set(visibleSet));
      },
      { threshold: 0.1 },
    );
    // Observe any already-registered cards
    for (const el of cardRefs.values()) observer.observe(el);
  });

  onCleanup(() => {
    observer?.disconnect();
  });

  function registerCard(cellIndex: number, el: HTMLElement): void {
    cardRefs.set(cellIndex, el);
    observer?.observe(el);
  }

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
        <div class="card-grid" data-tutorial="card-grid" style={{ '--grid-cols': gridColumns() }}>
          <For each={cells()}>
            {(cellIndex) => {
              const traces = createMemo(() => multiCellResults[cellIndex]);
              const pinnedTraces = createMemo(() => pinnedMultiCellResults[cellIndex]);
              const gt = createMemo(() => {
                if (!groundTruthVisible() || !isDemo()) return null;
                return getGroundTruthForCell(cellIndex);
              });
              return (
                <Show when={traces()}>
                  {(t) => (
                    <CellCard
                      cellIndex={cellIndex}
                      rawTrace={t().raw}
                      deconvolvedTrace={t().deconvolved}
                      reconvolutionTrace={t().reconvolution}
                      filteredTrace={t().filteredTrace}
                      samplingRate={samplingRate() ?? 30}
                      isActive={selectedCell() === cellIndex}
                      solverStatus={cellSolverStatuses[cellIndex] ?? 'stale'}
                      iterationCount={cellIterationCounts[cellIndex] ?? 0}
                      cardRef={(el) => registerCard(cellIndex, el)}
                      onClick={() => props.onCellClick(cellIndex)}
                      onZoomChange={reportCellZoom}
                      windowStartSample={t().windowStartSample}
                      pinnedDeconvolved={pinnedTraces()?.deconvolved}
                      pinnedReconvolution={pinnedTraces()?.reconvolution}
                      pinnedWindowStartSample={pinnedTraces()?.windowStartSample}
                      groundTruthSpikes={gt()?.spikes}
                      groundTruthCalcium={gt()?.calcium}
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
