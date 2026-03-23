// Parameter control panel grouping sliders (tPeak, FWHM, lambda)
// with a convergence indicator. Consumed by the App/tuning view.
// Lambda and solver status signals live in viz-store (centralized).

import {
  tPeak,
  fwhm,
  setTPeak,
  setFwhm,
  lambda,
  setLambda,
  filterEnabled,
  setFilterEnabled,
} from '../../lib/viz-store.ts';
import { tauToShape } from '@calab/compute';
import { notifyTutorialAction } from '@calab/tutorials';
import { isDemo, demoPreset, groundTruthVisible } from '../../lib/data-store.ts';
import { PARAM_RANGES } from '@calab/core';
import { ParameterSlider } from './ParameterSlider.tsx';
import '../../styles/controls.css';

export function ParameterPanel() {
  // Peak must be less than half the FWHM for a valid bi-exponential kernel.
  const peakMax = () => Math.min(PARAM_RANGES.tPeak.max, fwhm() / 2);
  const clampedSetTPeak = (v: number) => {
    setTPeak(Math.min(v, peakMax()));
  };
  const clampedSetFwhm = (v: number) => {
    setFwhm(v);
    if (tPeak() > v / 2) setTPeak(v / 2);
  };

  const trueShape = () => {
    if (!groundTruthVisible() || !isDemo() || !demoPreset()) return undefined;
    return (
      tauToShape(demoPreset()!.config.kernel.tau_rise_s, demoPreset()!.config.kernel.tau_decay_s) ??
      undefined
    );
  };

  return (
    <div class="param-panel" data-tutorial="param-panel">
      <div class="param-panel__sliders">
        <ParameterSlider
          label="Peak"
          value={tPeak}
          setValue={clampedSetTPeak}
          min={PARAM_RANGES.tPeak.min}
          max={peakMax()}
          step={PARAM_RANGES.tPeak.step}
          format={(v) => (v * 1000).toFixed(1)}
          unit="ms"
          data-tutorial="slider-peak"
          trueValue={trueShape()?.tPeak}
        />
        <ParameterSlider
          label="FWHM"
          value={fwhm}
          setValue={clampedSetFwhm}
          min={PARAM_RANGES.fwhm.min}
          max={PARAM_RANGES.fwhm.max}
          step={PARAM_RANGES.fwhm.step}
          format={(v) => (v * 1000).toFixed(1)}
          unit="ms"
          data-tutorial="slider-fwhm"
          trueValue={trueShape()?.fwhm}
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
