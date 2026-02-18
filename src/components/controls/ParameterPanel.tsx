// Parameter control panel grouping three sliders (tau_rise, tau_decay, lambda)
// with a convergence indicator. Consumed by the App/tuning view.
// Lambda and solver status signals live in viz-store (centralized).

import {
  tauRise, tauDecay, setTauRise, setTauDecay,
  lambda, setLambda,
  filterEnabled, setFilterEnabled,
} from '../../lib/viz-store.ts';
import { isDemo, demoPreset, groundTruthVisible } from '../../lib/data-store.ts';
import { PARAM_RANGES } from '../../lib/param-config.ts';
import { ParameterSlider } from './ParameterSlider.tsx';
import { ConvergenceIndicator } from './ConvergenceIndicator.tsx';
import '../../styles/controls.css';

export interface ParameterPanelProps {
  /** Called when any slider commits (onChange). Triggers batch re-solve. */
  onBatchSolve?: () => void;
}

export function ParameterPanel(props: ParameterPanelProps) {
  const handleCommit = () => {
    props.onBatchSolve?.();
  };

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
      <div class="param-panel__header">
        <ConvergenceIndicator />
      </div>
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
          onCommit={handleCommit}
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
          onCommit={handleCommit}
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
          onCommit={handleCommit}
          data-tutorial="slider-lambda"
        />
      </div>
      <label class="param-panel__toggle">
        <input
          type="checkbox"
          checked={filterEnabled()}
          onChange={(e) => setFilterEnabled(e.currentTarget.checked)}
        />
        <span class="param-panel__toggle-label">Noise Filter</span>
        <span class="param-panel__toggle-desc">Bandpass filter derived from kernel</span>
      </label>
    </div>
  );
}
