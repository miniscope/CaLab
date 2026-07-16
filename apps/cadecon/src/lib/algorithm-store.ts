import { createSignal, createMemo } from 'solid-js';
import { CONVERGENCE_RANGES } from '@calab/core';
import { samplingRate } from './data-store.ts';

// --- Algorithm parameter signals ---

const [upsampleTarget, setUpsampleTarget] = createSignal(300);
const [hpFilterEnabled, setHpFilterEnabled] = createSignal(true);
const [lpFilterEnabled, setLpFilterEnabled] = createSignal(true);
// Noise-constrained sparsity: pick the sparsest spike support whose residual
// still reaches the data-derived noise floor (no tuning knob). Suppresses noise
// fit as spurious spikes; benefit concentrates at low SNR. Off = current max-PVE.
const [noiseConstrained, setNoiseConstrained] = createSignal(true);
// Mass-based count readout: count events by relaxed mass (calibrated to the
// single-spike mass) and refit alpha, instead of binarize->bin-sum. Undoes the
// coherent-grid overcount that inflates spike counts and halves alpha at high
// upsampling. Off by default (preserves historical output); see
// docs/cadecon-mass-count.md.
const [massCount, setMassCount] = createSignal(false);
// Opt-in: during each iteration, also solve every trace with the OPPOSITE
// noise-constrained setting and store it, so the Trace Inspector can overlay the
// two instantly (no live solve). Doubles inference cost — off by default.
const [sparsityCompareEnabled, setSparsityCompareEnabled] = createSignal(false);
const [maxIterations, setMaxIterations] = createSignal(20);

// Convergence is tested in kernel SHAPE space (peak time + FWHM). convergenceTol
// is the relative change of BOTH peak and FWHM below which an iteration counts as
// stable; patience/minIters gate when convergence may be declared; the final
// kernel is the median of the last `finalSelectionWindow` iterates' shapes.
// Defaults live in @calab/core CONVERGENCE_RANGES (single source of truth).
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
  noiseConstrained,
  setNoiseConstrained,
  massCount,
  setMassCount,
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
  upsampleFactor,
};
