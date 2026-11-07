import { createSignal } from 'solid-js';
import { CONVERGENCE_RANGES } from '@calab/core';
import { DEFAULT_MAX_FIRING_RATE, isValidMaxFiringRate } from './max-firing-rate.ts';

// --- Algorithm parameter signals ---

// Highest burst rate (spikes/s): caps spikes per frame at max(1, round(rate / fs)).
const [maxFiringRate, setMaxFiringRateRaw] = createSignal<number>(DEFAULT_MAX_FIRING_RATE);
/** Set the max firing rate; values the solver would reject (not in (0, 10000]) are ignored. */
function setMaxFiringRate(v: number): void {
  if (isValidMaxFiringRate(v)) setMaxFiringRateRaw(v);
}
const [hpFilterEnabled, setHpFilterEnabled] = createSignal(true);
const [lpFilterEnabled, setLpFilterEnabled] = createSignal(true);
const [maxIterations, setMaxIterations] = createSignal(30);

// Convergence is tested with the peak-normalized RMSE between successive
// iterations' kernels. convergenceTol is the fraction-of-peak change below which
// an iteration counts as stable; patience/minIters gate when convergence may be
// declared; the final kernel is the median of the last `finalSelectionWindow`
// iterates' shapes. Defaults live in @calab/core CONVERGENCE_RANGES (single
// source of truth).
const [convergenceTol, setConvergenceTol] = createSignal<number>(
  CONVERGENCE_RANGES.convergenceTol.default,
);
const [convergencePatience, setConvergencePatience] = createSignal<number>(
  CONVERGENCE_RANGES.convergencePatience.default,
);
const [convergenceMinIters, setConvergenceMinIters] = createSignal<number>(
  CONVERGENCE_RANGES.convergenceMinIters.default,
);
const [finalSelectionWindow, setFinalSelectionWindow] = createSignal<number>(
  CONVERGENCE_RANGES.finalSelectionWindow.default,
);

// Inner-loop solver parameters. These directly affect deconvolution output, so
// they are configurable (not hardcoded) and travel with the run. Per-trace FISTA:
const [traceFistaMaxIters, setTraceFistaMaxIters] = createSignal(500);
const [traceFistaTol, setTraceFistaTol] = createSignal(1e-4);
// Per-subset free-form kernel estimation FISTA:
const [kernelFistaMaxIters, setKernelFistaMaxIters] = createSignal(200);
const [kernelFistaTol, setKernelFistaTol] = createSignal(1e-4);
// TV-L1 smoothness penalty for kernel estimation (0 = no smoothness):
const [kernelSmoothLambda, setKernelSmoothLambda] = createSignal(0);

export {
  maxFiringRate,
  setMaxFiringRate,
  hpFilterEnabled,
  setHpFilterEnabled,
  lpFilterEnabled,
  setLpFilterEnabled,
  maxIterations,
  setMaxIterations,
  convergenceTol,
  setConvergenceTol,
  convergencePatience,
  setConvergencePatience,
  convergenceMinIters,
  setConvergenceMinIters,
  finalSelectionWindow,
  setFinalSelectionWindow,
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
};
