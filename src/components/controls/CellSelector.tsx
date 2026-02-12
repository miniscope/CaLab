/**
 * Cell selection mode controls for multi-trace viewing.
 * Supports three modes: top-active, random, and manual cell selection.
 */

import { Show } from 'solid-js';
import type { SelectionMode } from '../../lib/multi-cell-store';
import {
  selectionMode,
  setSelectionMode,
  displayCount,
  setDisplayCount,
  selectedCells,
  setSelectedCells,
  updateCellSelection,
  gridColumns,
  setGridColumns,
} from '../../lib/multi-cell-store';
import { numCells } from '../../lib/data-store';
import '../../styles/multi-trace.css';

export interface CellSelectorProps {
  /** Called when selection changes (triggers batch re-solve). */
  onSelectionChange: () => void;
}

export function CellSelector(props: CellSelectorProps) {
  const handleModeChange = (e: Event) => {
    const value = (e.target as HTMLSelectElement).value as SelectionMode;
    setSelectionMode(value);
    updateCellSelection();
    props.onSelectionChange();
  };

  const handleCountChange = (e: Event) => {
    const value = parseInt((e.target as HTMLInputElement).value, 10);
    if (!isNaN(value) && value >= 1) {
      setDisplayCount(Math.min(value, Math.min(20, numCells())));
      updateCellSelection();
      props.onSelectionChange();
    }
  };

  const handleManualInput = (e: Event) => {
    const raw = (e.target as HTMLInputElement).value;
    const indices = raw
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !isNaN(n))
      .map((n) => n - 1) // Convert 1-indexed to 0-indexed
      .filter((n) => n >= 0 && n < numCells());

    // Deduplicate
    const unique = [...new Set(indices)];
    setSelectedCells(unique);
    props.onSelectionChange();
  };

  const handleGridColumnsChange = (e: Event) => {
    const value = parseInt((e.target as HTMLInputElement).value, 10);
    if (!isNaN(value) && value >= 1 && value <= 6) {
      setGridColumns(value);
    }
  };

  const handleReshuffle = () => {
    updateCellSelection();
    props.onSelectionChange();
  };

  const maxCount = () => Math.min(20, numCells());

  return (
    <div class="cell-selector" data-tutorial="cell-selector">
      <div class="cell-selector__group">
        <label class="cell-selector__label">Selection Mode</label>
        <select
          class="cell-selector__mode"
          value={selectionMode()}
          onChange={handleModeChange}
        >
          <option value="top-active">Top Active</option>
          <option value="random">Random</option>
          <option value="manual">Manual</option>
        </select>
      </div>

      <Show when={selectionMode() !== 'manual'}>
        <div class="cell-selector__group">
          <label class="cell-selector__label">Number of cells</label>
          <input
            class="cell-selector__count"
            type="number"
            min={1}
            max={maxCount()}
            value={displayCount()}
            onChange={handleCountChange}
          />
        </div>
      </Show>

      <div class="cell-selector__group">
        <label class="cell-selector__label">Grid columns</label>
        <div class="cell-selector__stepper">
          <button class="cell-selector__step-btn" onClick={() => gridColumns() > 1 && setGridColumns(gridColumns() - 1)}>−</button>
          <span class="cell-selector__step-value">{gridColumns()}</span>
          <button class="cell-selector__step-btn" onClick={() => gridColumns() < 6 && setGridColumns(gridColumns() + 1)}>+</button>
        </div>
      </div>

      <Show when={selectionMode() === 'random'}>
        <button class="btn-secondary btn-small" onClick={handleReshuffle}>
          Reshuffle
        </button>
      </Show>

      <Show when={selectionMode() === 'manual'}>
        <div class="cell-selector__group">
          <label class="cell-selector__label">Cell indices (1-indexed)</label>
          <input
            class="cell-selector__manual"
            type="text"
            placeholder="e.g., 1, 5, 10"
            value={selectedCells()
              .map((i) => i + 1)
              .join(', ')}
            onBlur={handleManualInput}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleManualInput(e);
            }}
          />
        </div>
      </Show>
    </div>
  );
}
