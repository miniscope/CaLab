import { createSignal, createMemo } from 'solid-js';
import { samplingRate } from './data-store.ts';

// --- Algorithm parameter signals ---

// Initial kernel time constants (seconds). These MUST start at or above the
// true values. The iterative solver can only refine time constants downward —
// a too-fast kernel is compensated by placing extra spikes, so the free-form
// kernel never receives an error signal pushing it slower. Starting from
// conservatively slow values ensures the optimizer passes through the optimum
// on the way down, where best-residual tracking (iteration-manager.ts) catches it.
const [tauRiseInit, setTauRiseInit] = createSignal(0.2);
const [tauDecayInit, setTauDecayInit] = createSignal(1.0);
const [upsampleTarget, setUpsampleTarget] = createSignal(300);
const [weightingEnabled, setWeightingEnabled] = createSignal(false);
const [hpFilterEnabled, setHpFilterEnabled] = createSignal(true);
const [lpFilterEnabled, setLpFilterEnabled] = createSignal(false);
const [maxIterations, setMaxIterations] = createSignal(20);
const [convergenceTol, setConvergenceTol] = createSignal(0.01);

// --- Derived ---

const upsampleFactor = createMemo(() => {
  const fs = samplingRate();
  if (!fs || fs <= 0) return 1;
  return Math.max(1, Math.round(upsampleTarget() / fs));
});

export {
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
  upsampleFactor,
};
