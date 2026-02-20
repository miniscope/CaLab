/**
 * Cell selection mode controls for multi-trace viewing.
 * Supports three modes: top-active, random, and manual cell selection.
 */

import { createSignal, type Accessor, type Setter, Show } from 'solid-js';
import type { SelectionMode } from '../../lib/multi-cell-store.ts';
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
} from '../../lib/multi-cell-store.ts';
import { numCells, groundTruthVisible } from '../../lib/data-store.ts';
import {
  filterEnabled,
  showRaw,
  setShowRaw,
  showFiltered,
  setShowFiltered,
  showFit,
  setShowFit,
  showDeconv,
  setShowDeconv,
  showResid,
  setShowResid,
  showGTCalcium,
  setShowGTCalcium,
  showGTSpikes,
  setShowGTSpikes,
} from '../../lib/viz-store.ts';
import '../../styles/multi-trace.css';

export interface CellSelectorProps {
  /** Called when selection changes (triggers batch re-solve). */
  onSelectionChange?: () => void;
}

interface LegendItemProps {
  color: string;
  label: string;
  visible: Accessor<boolean>;
  setVisible: Setter<boolean>;
  dashed?: boolean;
}

function LegendItem(props: LegendItemProps) {
  const swatchClass = () =>
    props.dashed
      ? 'cell-selector__legend-swatch cell-selector__legend-swatch--dashed'
      : 'cell-selector__legend-swatch';

  const swatchStyle = () =>
    props.dashed ? { 'border-color': props.color } : { background: props.color };

  return (
    <span
      class="cell-selector__legend-item"
      classList={{ 'cell-selector__legend-item--hidden': !props.visible() }}
      onClick={() => props.setVisible((v) => !v)}
    >
      <span class={swatchClass()} style={swatchStyle()} />
      {props.label}
    </span>
  );
}

export function CellSelector(props: CellSelectorProps) {
  const handleModeChange = (e: Event) => {
    const value = (e.target as HTMLSelectElement).value as SelectionMode;
    setSelectionMode(value);
    updateCellSelection();
    props.onSelectionChange?.();
  };

  const handleCountChange = (e: Event) => {
    const value = parseInt((e.target as HTMLInputElement).value, 10);
    if (!isNaN(value) && value >= 1) {
      setDisplayCount(Math.min(value, Math.min(20, numCells())));
      updateCellSelection();
      props.onSelectionChange?.();
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
    props.onSelectionChange?.();
  };

  const handleReshuffle = () => {
    updateCellSelection();
    props.onSelectionChange?.();
  };

  const maxCount = () => Math.min(20, numCells());
  const [showLegendInfo, setShowLegendInfo] = createSignal(false);

  return (
    <div class="cell-selector" data-tutorial="cell-selector">
      <div class="cell-selector__group">
        <label class="cell-selector__label">Selection Mode</label>
        <select class="cell-selector__mode" value={selectionMode()} onChange={handleModeChange}>
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

      <div class="cell-selector__group" data-tutorial="grid-columns">
        <label class="cell-selector__label">Grid columns</label>
        <div class="cell-selector__stepper">
          <button
            class="cell-selector__step-btn"
            onClick={() => gridColumns() > 1 && setGridColumns(gridColumns() - 1)}
          >
            −
          </button>
          <span class="cell-selector__step-value">{gridColumns()}</span>
          <button
            class="cell-selector__step-btn"
            onClick={() => gridColumns() < 6 && setGridColumns(gridColumns() + 1)}
          >
            +
          </button>
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

      <div class="cell-selector__legend" data-tutorial="legend-bar">
        <button
          class="legend-info__btn"
          title="What do these traces mean?"
          onClick={() => setShowLegendInfo((v) => !v)}
        >
          ?
        </button>
        <Show when={showLegendInfo()}>
          <div class="legend-info__popover">
            <div class="legend-info__row">
              <strong>Raw</strong> — Original fluorescence recording
            </div>
            <div class="legend-info__row">
              <strong>Filtered</strong> — Bandpass-filtered trace (drift + noise removed)
            </div>
            <div class="legend-info__row">
              <strong>Fit</strong> — Reconvolved model fit (kernel * deconvolved activity +
              baseline)
            </div>
            <div class="legend-info__row">
              <strong>Deconv</strong> — Estimated neural activity (deconvolution result)
            </div>
            <div class="legend-info__row">
              <strong>Resid</strong> — Residuals (Raw minus Fit)
            </div>
            <div class="legend-info__row">
              <strong>True Ca/Spk</strong> — Ground truth (demo only)
            </div>
            <div class="legend-info__hint">Click legend items to toggle traces on/off</div>
          </div>
        </Show>
        <LegendItem color="#1f77b4" label="Raw" visible={showRaw} setVisible={setShowRaw} />
        <Show when={filterEnabled()}>
          <LegendItem
            color="#17becf"
            label="Filtered"
            visible={showFiltered}
            setVisible={setShowFiltered}
          />
        </Show>
        <LegendItem color="#ff7f0e" label="Fit" visible={showFit} setVisible={setShowFit} />
        <LegendItem
          color="#2ca02c"
          label="Deconv"
          visible={showDeconv}
          setVisible={setShowDeconv}
        />
        <LegendItem color="#d62728" label="Resid" visible={showResid} setVisible={setShowResid} />
        <Show when={groundTruthVisible()}>
          <LegendItem
            color="rgba(0, 188, 212, 0.7)"
            label="True Ca"
            visible={showGTCalcium}
            setVisible={setShowGTCalcium}
            dashed
          />
          <LegendItem
            color="rgba(255, 193, 7, 0.7)"
            label="True Spk"
            visible={showGTSpikes}
            setVisible={setShowGTSpikes}
          />
        </Show>
      </div>
    </div>
  );
}
