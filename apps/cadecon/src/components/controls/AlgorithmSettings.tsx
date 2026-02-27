import type { JSX } from 'solid-js';
import { ParameterSlider } from './ParameterSlider.tsx';
import { DualRangeSlider } from './DualRangeSlider.tsx';
import { ToggleSwitch } from './ToggleSwitch.tsx';
import {
  tauRiseInit,
  setTauRiseInit,
  tauDecayInit,
  setTauDecayInit,
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
import { runState } from '../../lib/iteration-store.ts';

export function AlgorithmSettings(): JSX.Element {
  const locked = () => runState() !== 'idle' && runState() !== 'complete';

  return (
    <div class="param-panel">
      <div class="param-panel__sliders">
        <DualRangeSlider
          label="Initial Kernel τ's"
          lowLabel="Rise"
          highLabel="Decay"
          lowValue={tauRiseInit}
          highValue={tauDecayInit}
          setLowValue={setTauRiseInit}
          setHighValue={setTauDecayInit}
          min={0.01}
          max={3.0}
          step={0.01}
          format={(v) => (v * 1000).toFixed(0)}
          unit="ms"
          disabled={locked()}
        />

        <ParameterSlider
          label="Upsample Target"
          value={upsampleTarget}
          setValue={(v) => setUpsampleTarget(Math.round(v))}
          min={100}
          max={1000}
          step={10}
          format={(v) => String(Math.round(v))}
          unit="Hz"
          disabled={locked()}
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
          disabled={locked()}
          noSlider
        />

        <ParameterSlider
          label="Convergence Tol"
          value={convergenceTol}
          setValue={setConvergenceTol}
          min={0.001}
          max={0.1}
          step={0.001}
          format={(v) => v.toFixed(3)}
          disabled={locked()}
          noSlider
        />

        <ToggleSwitch
          label="Cell Weighting"
          description="Weight cells by SNR during kernel updates"
          checked={weightingEnabled()}
          onChange={setWeightingEnabled}
          disabled={locked()}
        />

        <ToggleSwitch
          label="High-Pass Filter"
          description="Remove baseline drift before deconvolution"
          checked={hpFilterEnabled()}
          onChange={setHpFilterEnabled}
          disabled={locked()}
        />

        <ToggleSwitch
          label="Low-Pass Filter"
          description="Remove high-frequency noise before deconvolution"
          checked={lpFilterEnabled()}
          onChange={setLpFilterEnabled}
          disabled={locked()}
        />
      </div>
    </div>
  );
}
