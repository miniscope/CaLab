import type { JSX } from 'solid-js';
import { CONVERGENCE_RANGES } from '@calab/core';
import { ParameterSlider } from './ParameterSlider.tsx';
import { ToggleSwitch } from './ToggleSwitch.tsx';
import {
  maxFiringRate,
  setMaxFiringRate,
  hpFilterEnabled,
  setHpFilterEnabled,
  lpFilterEnabled,
  setLpFilterEnabled,
  maxIterations,
  setMaxIterations,
  convergenceTol,
  setConvergenceTol,
  convergencePatience,
  setConvergencePatience,
} from '../../lib/algorithm-store.ts';
import { MAX_FIRING_RATE_HELP, MAX_FIRING_RATE_LIMIT } from '../../lib/max-firing-rate.ts';
import { isRunLocked } from '../../lib/iteration-store.ts';

export function AlgorithmSettings(): JSX.Element {
  return (
    <div class="param-panel">
      <div class="param-panel__sliders">
        <ParameterSlider
          label="Max firing rate (spikes/s)"
          value={maxFiringRate}
          setValue={setMaxFiringRate}
          min={1}
          max={MAX_FIRING_RATE_LIMIT}
          step={10}
          format={(v) => String(v)}
          help={MAX_FIRING_RATE_HELP}
          disabled={isRunLocked()}
          noSlider
        />

        <ParameterSlider
          label="Max Iterations"
          value={maxIterations}
          setValue={(v) => setMaxIterations(Math.round(v))}
          min={1}
          max={100}
          step={1}
          format={(v) => String(Math.round(v))}
          disabled={isRunLocked()}
          noSlider
        />

        <ParameterSlider
          label="Convergence Tol"
          value={convergenceTol}
          setValue={setConvergenceTol}
          min={CONVERGENCE_RANGES.convergenceTol.min}
          max={CONVERGENCE_RANGES.convergenceTol.max}
          step={CONVERGENCE_RANGES.convergenceTol.step}
          format={(v) => v.toFixed(3)}
          disabled={isRunLocked()}
          noSlider
        />

        <ParameterSlider
          label="Patience"
          value={convergencePatience}
          setValue={(v) => setConvergencePatience(Math.round(v))}
          min={CONVERGENCE_RANGES.convergencePatience.min}
          max={CONVERGENCE_RANGES.convergencePatience.max}
          step={CONVERGENCE_RANGES.convergencePatience.step}
          format={(v) => String(Math.round(v))}
          unit="iters"
          disabled={isRunLocked()}
          noSlider
        />

        <ToggleSwitch
          label="High-Pass Filter"
          description="Remove baseline drift before deconvolution"
          checked={hpFilterEnabled()}
          onChange={setHpFilterEnabled}
          disabled={isRunLocked()}
        />

        <ToggleSwitch
          label="Low-Pass Filter"
          description="Remove high-frequency noise before deconvolution"
          checked={lpFilterEnabled()}
          onChange={setLpFilterEnabled}
          disabled={isRunLocked()}
        />
      </div>
    </div>
  );
}
