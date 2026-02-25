import { Show, type JSX } from 'solid-js';
import { ParameterSlider } from './ParameterSlider.tsx';
import {
  numSubsets,
  setNumSubsets,
  autoMode,
  setAutoMode,
  effectiveTSub,
  effectiveNSub,
  subsetTimeFrames,
  setSubsetTimeFrames,
  subsetCellCount,
  setSubsetCellCount,
  overlapAllowed,
  setOverlapAllowed,
  coverageStats,
  seed,
  setSeed,
} from '../../lib/subset-store.ts';
import { numCells, numTimepoints } from '../../lib/data-store.ts';

export function SubsetConfig(): JSX.Element {
  return (
    <div class="param-panel">
      <div class="param-panel__header">
        <p class="panel-label">Subset Configuration</p>
      </div>
      <div class="param-panel__sliders">
        <ParameterSlider
          label="Subsets (K)"
          value={numSubsets}
          setValue={(v) => setNumSubsets(Math.round(v))}
          min={1}
          max={20}
          step={1}
          format={(v) => String(Math.round(v))}
        />

        <div class="param-panel__toggle-group">
          <label class="param-panel__toggle">
            <input
              type="checkbox"
              checked={autoMode()}
              onChange={(e) => setAutoMode(e.currentTarget.checked)}
            />
            <div>
              <span class="param-panel__toggle-label">Auto Size</span>
              <span class="param-panel__toggle-desc">
                T_sub = {effectiveTSub().toLocaleString()}, N_sub = {effectiveNSub()}
              </span>
            </div>
          </label>
        </div>

        <Show when={!autoMode()}>
          <ParameterSlider
            label="T_sub (timepoints)"
            value={() => subsetTimeFrames() ?? effectiveTSub()}
            setValue={(v) => setSubsetTimeFrames(Math.round(v))}
            min={100}
            max={numTimepoints()}
            step={10}
            format={(v) => String(Math.round(v))}
          />
          <ParameterSlider
            label="N_sub (cells)"
            value={() => subsetCellCount() ?? effectiveNSub()}
            setValue={(v) => setSubsetCellCount(Math.round(v))}
            min={1}
            max={numCells()}
            step={1}
            format={(v) => String(Math.round(v))}
          />
        </Show>

        <div class="param-panel__toggle-group">
          <label class="param-panel__toggle">
            <input
              type="checkbox"
              checked={overlapAllowed()}
              onChange={(e) => setOverlapAllowed(e.currentTarget.checked)}
            />
            <span class="param-panel__toggle-label">Allow Overlap</span>
          </label>
        </div>

        <div class="param-panel__toggle-group" style="border-top: none; margin-top: 0;">
          <button
            class="btn-secondary btn-small"
            onClick={() => setSeed(Math.floor(Math.random() * 2 ** 31))}
          >
            Randomize Layout
          </button>
          <span class="param-panel__toggle-desc" style="margin-top: 4px;">
            Seed: {seed()}
          </span>
        </div>
      </div>

      {/* Coverage stats */}
      <div class="stats-grid" style="margin-top: var(--space-md);">
        <div class="stat-item">
          <span class="stat-item__label">Cell Coverage</span>
          <span class="stat-item__value">{coverageStats().cellPct.toFixed(0)}%</span>
        </div>
        <div class="stat-item">
          <span class="stat-item__label">Time Coverage</span>
          <span class="stat-item__value">{coverageStats().timePct.toFixed(0)}%</span>
        </div>
        <div class="stat-item">
          <span class="stat-item__label">K</span>
          <span class="stat-item__value">{numSubsets()}</span>
        </div>
      </div>
    </div>
  );
}
