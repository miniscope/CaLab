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
} from '../../lib/subset-store.ts';
import { runState } from '../../lib/iteration-store.ts';

export function SubsetConfig(): JSX.Element {
  const locked = () => runState() !== 'idle' && runState() !== 'complete';

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
          disabled={locked()}
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
          disabled={locked()}
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
          disabled={locked()}
        />
      </div>

      <p class="subset-stats-inline">
        {coverageStats().cellPct.toFixed(0)}% cells, {coverageStats().timePct.toFixed(0)}% time,{' '}
        {coverageStats().totalPct.toFixed(0)}% total
      </p>

      <Show when={numSubsets() > maxNonOverlappingK()}>
        <span class="stat-item__warn">K &gt; {maxNonOverlappingK()} causes overlap</span>
      </Show>
    </div>
  );
}
