// Parameter control panel grouping three sliders (tau_rise, tau_decay, lambda)
// with a convergence indicator. Consumed by the App/tuning view.
// Lambda and solver status signals live in viz-store (centralized).

import {
  tauRise,
  tauDecay,
  setTauRise,
  setTauDecay,
  lambda,
  setLambda,
  filterEnabled,
  setFilterEnabled,
} from '../../lib/viz-store.ts';
import { notifyTutorialAction } from '../../lib/tutorial/tutorial-engine.ts';
import { isDemo, demoPreset, groundTruthVisible } from '../../lib/data-store.ts';
import { PARAM_RANGES } from '@calab/core';
import { ParameterSlider } from './ParameterSlider.tsx';
import '../../styles/controls.css';

export function ParameterPanel() {
  const trueRise = () => {
    if (!groundTruthVisible() || !isDemo() || !demoPreset()) return undefined;
    return demoPreset()!.params.tauRise;
  };

  const trueDecay = () => {
    if (!groundTruthVisible() || !isDemo() || !demoPreset()) return undefined;
    return demoPreset()!.params.tauDecay;
  };

  return (
    <div class="param-panel" data-tutorial="param-panel">
      <div class="param-panel__sliders">
        <ParameterSlider
          label="Rise Time"
          value={tauRise}
          setValue={setTauRise}
          min={PARAM_RANGES.tauRise.min}
          max={PARAM_RANGES.tauRise.max}
          step={PARAM_RANGES.tauRise.step}
          format={(v) => (v * 1000).toFixed(1)}
          unit="ms"
          data-tutorial="slider-rise"
          trueValue={trueRise()}
        />
        <ParameterSlider
          label="Decay Time"
          value={tauDecay}
          setValue={setTauDecay}
          min={PARAM_RANGES.tauDecay.min}
          max={PARAM_RANGES.tauDecay.max}
          step={PARAM_RANGES.tauDecay.step}
          format={(v) => (v * 1000).toFixed(1)}
          unit="ms"
          data-tutorial="slider-decay"
          trueValue={trueDecay()}
        />
        <ParameterSlider
          label="Sparsity"
          value={lambda}
          setValue={setLambda}
          min={PARAM_RANGES.lambda.min}
          max={PARAM_RANGES.lambda.max}
          step={0.01}
          format={(v) => v.toFixed(2)}
          data-tutorial="slider-lambda"
        />
      </div>
      <div class="param-panel__toggle-group" data-tutorial="noise-filter">
        <label class="param-panel__toggle">
          <input
            type="checkbox"
            checked={filterEnabled()}
            onChange={(e) => {
              setFilterEnabled(e.currentTarget.checked);
              notifyTutorialAction();
            }}
          />
          <span class="param-panel__toggle-label">Noise Filter</span>
        </label>
        <span class="param-panel__toggle-desc">Bandpass filter derived from kernel</span>
      </div>
    </div>
  );
}
