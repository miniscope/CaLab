import { createSignal, Show, type JSX } from 'solid-js';
import { ParameterSlider } from './ParameterSlider.tsx';
import { ToggleSwitch } from './ToggleSwitch.tsx';

// --- Module-level signals ---

const [tauRiseInit, setTauRiseInit] = createSignal(0.1);
const [tauDecayInit, setTauDecayInit] = createSignal(0.6);
const [autoInitKernel, setAutoInitKernel] = createSignal(true);
const [upsampleTarget, setUpsampleTarget] = createSignal(300);
const [weightingEnabled, setWeightingEnabled] = createSignal(true);
const [bandpassEnabled, setBandpassEnabled] = createSignal(false);
const [maxIterations, setMaxIterations] = createSignal(10);
const [convergenceTol, setConvergenceTol] = createSignal(0.01);

export {
  tauRiseInit,
  tauDecayInit,
  autoInitKernel,
  upsampleTarget,
  weightingEnabled,
  bandpassEnabled,
  maxIterations,
  convergenceTol,
};

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
          label="Bandpass Filter"
          description="Apply bandpass filtering before deconvolution"
          checked={bandpassEnabled()}
          onChange={setBandpassEnabled}
        />
      </div>
    </div>
  );
}
