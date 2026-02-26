import { Show, type JSX } from 'solid-js';
import { ParameterSlider } from './ParameterSlider.tsx';
import {
  numSubsets,
  setNumSubsets,
  targetCoverage,
  setTargetCoverage,
  aspectRatio,
  setAspectRatio,
  coverageStats,
  maxNonOverlappingK,
  seed,
  setSeed,
} from '../../lib/subset-store.ts';

export function SubsetConfig(): JSX.Element {
  return (
    <div class="param-panel">
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

        <ParameterSlider
          label="Total Coverage"
          value={() => targetCoverage() * 100}
          setValue={(v) => setTargetCoverage(Math.round(v) / 100)}
          min={10}
          max={100}
          step={5}
          format={(v) => String(Math.round(v))}
          unit="%"
        />

        <ParameterSlider
          label="Subset Aspect Ratio"
          value={aspectRatio}
          setValue={setAspectRatio}
          min={0}
          max={1}
          step={0.001}
          toSlider={(v) => Math.log2(v) / 6 + 0.5}
          fromSlider={(p) => Math.pow(2, (p - 0.5) * 6)}
          format={(v) => v.toFixed(1)}
        />

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

      <div class="stats-grid">
        <div class="stat-item">
          <span class="stat-item__label">Cells/subset</span>
          <span class="stat-item__value">{coverageStats().cellPct.toFixed(0)}%</span>
        </div>
        <div class="stat-item">
          <span class="stat-item__label">Time/subset</span>
          <span class="stat-item__value">{coverageStats().timePct.toFixed(0)}%</span>
        </div>
        <div class="stat-item">
          <span class="stat-item__label">Total coverage</span>
          <span class="stat-item__value">{coverageStats().totalPct.toFixed(0)}%</span>
        </div>
      </div>

      <Show when={numSubsets() > maxNonOverlappingK()}>
        <span class="stat-item__warn">K &gt; {maxNonOverlappingK()} causes overlap</span>
      </Show>
    </div>
  );
}
