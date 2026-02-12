// Parameter control panel grouping three sliders (tau_rise, tau_decay, lambda)
// with a convergence indicator. Consumed by the App/tuning view.
// Lambda and solver status signals live in viz-store (centralized).

import {
  tauRise, tauDecay, setTauRise, setTauDecay,
  lambda, setLambda,
} from '../../lib/viz-store';
import { PARAM_RANGES } from '../../lib/param-config';
import { ParameterSlider } from './ParameterSlider';
import { ConvergenceIndicator } from './ConvergenceIndicator';
import '../../styles/controls.css';

export interface ParameterPanelProps {
  /** Called when any slider commits (onChange). Triggers batch re-solve. */
  onBatchSolve?: () => void;
}

export function ParameterPanel(props: ParameterPanelProps) {
  const handleCommit = () => {
    props.onBatchSolve?.();
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
        />
        <ParameterSlider
          label="Sparsity (lambda)"
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
    </div>
  );
}
