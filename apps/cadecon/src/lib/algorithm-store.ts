import { createSignal, createMemo } from 'solid-js';
import { samplingRate } from './data-store.ts';

// --- Algorithm parameter signals ---

const [tauRiseInit, setTauRiseInit] = createSignal(0.1);
const [tauDecayInit, setTauDecayInit] = createSignal(0.6);
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
