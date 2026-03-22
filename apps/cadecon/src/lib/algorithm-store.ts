import { createSignal, createMemo } from 'solid-js';
import { samplingRate } from './data-store.ts';

// --- Algorithm parameter signals ---

const [upsampleTarget, setUpsampleTarget] = createSignal(300);
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
  upsampleTarget,
  setUpsampleTarget,
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
