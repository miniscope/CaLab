// Parameter control panel grouping three sliders (tau_rise, tau_decay, lambda)
// with a convergence indicator. Consumed by the App/tuning view.
//
// Note: lambda signal is local for now. Plan 03 will integrate it into
// viz-store when wiring the full reactive loop.

import { createSignal } from 'solid-js';
import { tauRise, tauDecay, setTauRise, setTauDecay } from '../../lib/viz-store';
import {
  PARAM_RANGES,
  sliderToLambda,
  lambdaToSlider,
} from '../../lib/param-history';
import type { ParamSnapshot } from '../../lib/param-history';
import { ParameterSlider } from './ParameterSlider';
import { ConvergenceIndicator } from './ConvergenceIndicator';
import '../../styles/controls.css';

// Local lambda signal (will be moved to viz-store in Plan 03)
const [lambda, setLambda] = createSignal<number>(PARAM_RANGES.lambda.default);

export { lambda, setLambda };

export interface ParameterPanelProps {
  /** Called when any slider commits (onChange). Provides the full parameter
   *  snapshot for undo history. */
  onCommit?: (snapshot: ParamSnapshot) => void;
}

/** Collect current parameter values into a snapshot. */
function collectSnapshot(): ParamSnapshot {
  return {
    tauRise: tauRise(),
    tauDecay: tauDecay(),
    lambda: lambda(),
  };
}

export function ParameterPanel(props: ParameterPanelProps) {
  const handleCommit = () => {
    props.onCommit?.(collectSnapshot());
  };

  return (
    <div class="param-panel">
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
        />
        <ParameterSlider
          label="Sparsity (lambda)"
          value={lambda}
          setValue={setLambda}
          min={PARAM_RANGES.lambda.min}
          max={PARAM_RANGES.lambda.max}
          step={0.0001}
          fromSlider={sliderToLambda}
          toSlider={lambdaToSlider}
          format={(v) => v.toExponential(2)}
          onCommit={handleCommit}
        />
      </div>
    </div>
  );
}
