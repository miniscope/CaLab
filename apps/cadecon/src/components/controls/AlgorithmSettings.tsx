import { Show, type JSX } from 'solid-js';
import { ParameterSlider } from './ParameterSlider.tsx';
import { ToggleSwitch } from './ToggleSwitch.tsx';
import {
  tauRiseInit,
  setTauRiseInit,
  tauDecayInit,
  setTauDecayInit,
  autoInitKernel,
  setAutoInitKernel,
  upsampleTarget,
  setUpsampleTarget,
  weightingEnabled,
  setWeightingEnabled,
  hpFilterEnabled,
  setHpFilterEnabled,
  lpFilterEnabled,
  setLpFilterEnabled,
  maxIterations,
  setMaxIterations,
  convergenceTol,
  setConvergenceTol,
} from '../../lib/algorithm-store.ts';

export function AlgorithmSettings(): JSX.Element {
  return (
    <div class="param-panel">
      <div class="param-panel__sliders">
        <ToggleSwitch
          label="Auto Init Kernel"
          description="Estimate initial tau values from data autocorrelation"
          checked={autoInitKernel()}
          onChange={setAutoInitKernel}
          style="border-top: none; padding-top: 0;"
        />

        <Show when={!autoInitKernel()}>
          <ParameterSlider
            label="Tau Rise (init)"
            value={tauRiseInit}
            setValue={setTauRiseInit}
            min={0.01}
            max={1.0}
            step={0.01}
            format={(v) => (v * 1000).toFixed(0)}
            unit="ms"
          />
          <ParameterSlider
            label="Tau Decay (init)"
            value={tauDecayInit}
            setValue={setTauDecayInit}
            min={0.05}
            max={3.0}
            step={0.01}
            format={(v) => (v * 1000).toFixed(0)}
            unit="ms"
          />
        </Show>

        <ParameterSlider
          label="Upsample Target"
          value={upsampleTarget}
          setValue={(v) => setUpsampleTarget(Math.round(v))}
          min={100}
          max={1000}
          step={10}
          format={(v) => String(Math.round(v))}
          unit="Hz"
        />

        <ParameterSlider
          label="Max Iterations"
          value={maxIterations}
          setValue={(v) => setMaxIterations(Math.round(v))}
          min={1}
          max={100}
          step={1}
          format={(v) => String(Math.round(v))}
        />

        <ParameterSlider
          label="Convergence Tol"
          value={convergenceTol}
          setValue={setConvergenceTol}
          min={0.001}
          max={0.1}
          step={0.001}
          format={(v) => v.toFixed(3)}
        />

        <ToggleSwitch
          label="Cell Weighting"
          description="Weight cells by SNR during kernel updates"
          checked={weightingEnabled()}
          onChange={setWeightingEnabled}
        />

        <ToggleSwitch
          label="High-Pass Filter"
          description="Remove baseline drift before deconvolution"
          checked={hpFilterEnabled()}
          onChange={setHpFilterEnabled}
        />

        <ToggleSwitch
          label="Low-Pass Filter"
          description="Remove high-frequency noise before deconvolution"
          checked={lpFilterEnabled()}
          onChange={setLpFilterEnabled}
        />
      </div>
    </div>
  );
}
