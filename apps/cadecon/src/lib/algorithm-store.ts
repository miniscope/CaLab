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
// Noise-constrained sparsity: pick the sparsest spike support whose residual
// still reaches the data-derived noise floor (no tuning knob). Suppresses noise
// fit as spurious spikes; benefit concentrates at low SNR. Off = current max-PVE.
const [noiseConstrained, setNoiseConstrained] = createSignal(true);
// Opt-in: during each iteration, also solve every trace with the OPPOSITE
// noise-constrained setting and store it, so the Trace Inspector can overlay the
// two instantly (no live solve). Doubles inference cost — off by default.
const [sparsityCompareEnabled, setSparsityCompareEnabled] = createSignal(false);
const [maxIterations, setMaxIterations] = createSignal(20);

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
  noiseConstrained,
  setNoiseConstrained,
  sparsityCompareEnabled,
  setSparsityCompareEnabled,
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
