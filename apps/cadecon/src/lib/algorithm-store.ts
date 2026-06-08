import { createSignal, createMemo } from 'solid-js';
import { samplingRate } from './data-store.ts';

// --- Algorithm parameter signals ---

const [upsampleTarget, setUpsampleTarget] = createSignal(300);
const [hpFilterEnabled, setHpFilterEnabled] = createSignal(true);
const [lpFilterEnabled, setLpFilterEnabled] = createSignal(false);
const [maxIterations, setMaxIterations] = createSignal(20);
const [convergenceTol, setConvergenceTol] = createSignal(0.01);

// Inner-loop solver parameters. These directly affect deconvolution output, so
// they are configurable (not hardcoded) and travel with the run; defaults match
// the previously hardcoded values. Per-trace FISTA:
const [traceFistaMaxIters, setTraceFistaMaxIters] = createSignal(500);
const [traceFistaTol, setTraceFistaTol] = createSignal(1e-4);
// Per-subset free-form kernel estimation FISTA:
const [kernelFistaMaxIters, setKernelFistaMaxIters] = createSignal(200);
const [kernelFistaTol, setKernelFistaTol] = createSignal(1e-4);
// TV-L1 smoothness penalty for kernel estimation (0 = no smoothness):
const [kernelSmoothLambda, setKernelSmoothLambda] = createSignal(0);

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
  traceFistaMaxIters,
  setTraceFistaMaxIters,
  traceFistaTol,
  setTraceFistaTol,
  kernelFistaMaxIters,
  setKernelFistaMaxIters,
  kernelFistaTol,
  setKernelFistaTol,
  kernelSmoothLambda,
  setKernelSmoothLambda,
  upsampleFactor,
};
