// TUTR-05: Deconvolution Theory tutorial.
// Standalone conceptual tutorial covering the math, solver mechanics,
// critical pitfalls, and how to interpret deconvolution results.
// All steps are centered modals (no element field).
// Pure data definition -- no driver.js imports (TUTR-05 compliance).

import type { Tutorial } from '../types.ts';
import {
  renderKernelShape,
  renderDecayComparison,
  renderDeltaTrap,
  renderGoodVsBad,
} from '../theory-figures.ts';

export const theoryTutorial: Tutorial = {
  id: 'theory',
  title: 'Deconvolution Theory',
  description:
    'Understand the math behind deconvolution, how the solver works, critical pitfalls of kernel selection, and how to properly interpret results.',
  level: 'theory',
  prerequisites: [],
  estimatedMinutes: 8,
  recommended: true,
  requiresData: false,
  steps: [
    // Step 1: Introduction
    {
      title: 'Deconvolution Theory',
      description:
        'This tutorial covers the <b>mathematical foundations</b> of calcium deconvolution — the forward model, how the solver works, critical pitfalls in parameter selection, and how to interpret (and not over-interpret) the results. No UI interaction needed — just read and advance.',
    },
    // Step 2: What's in the raw trace?
    {
      title: "What's in the Raw Trace?",
      description:
        'The recorded fluorescence <b>F(t)</b> is a mixture of three components:<br><br>' +
        "<b>1. Calcium transients</b> — neural activity convolved with the indicator's impulse response<br>" +
        '<b>2. High-frequency noise</b> — photon shot noise and electronics<br>' +
        '<b>3. Slow baseline drift</b> — out-of-focus neuropil, diffuse calcium dynamics, photobleaching<br><br>' +
        'Mathematically:<br>' +
        '<b>F(t) = (s ∗ k)(t) + b(t) + ε(t)</b><br><br>' +
        'where <b>s</b> is neural activity, <b>k</b> is the calcium kernel, <b>b</b> is baseline drift, and <b>ε</b> is noise. Deconvolution aims to recover <b>s</b> from <b>F</b>.',
    },
    // Step 3: The calcium kernel
    {
      title: 'The Calcium Kernel',
      description:
        'Each action potential triggers a calcium influx that rises quickly and decays exponentially. The kernel <b>k(t)</b> models this shape using two time constants:<br><br>' +
        '<b>τ_rise</b> — onset speed (how fast calcium appears)<br>' +
        '<b>τ_decay</b> — return to baseline (how fast calcium clears)<br><br>' +
        'The kernel shape:<br>' +
        '<b>k(t) = e<sup>−t/τ_decay</sup> − e<sup>−t/τ_rise</sup></b><br><br>' +
        'This is the <b>template</b> the solver uses to match events in your data. Getting its shape right is the single most critical step in the entire analysis.',
      onPopoverRender: renderKernelShape,
    },
    // Step 4: The deconvolution problem
    {
      title: 'The Deconvolution Problem',
      description:
        'Given the observed fluorescence <b>F(t)</b> and a kernel <b>k(t)</b>, the goal is to recover the underlying activity <b>s(t)</b>. This is an <b>inverse problem</b>: undo the convolution to find what neural activity, when convolved with the kernel, best explains the data.<br><br>' +
        'The solver minimizes:<br>' +
        '<b>‖F − k∗s‖² + λ‖s‖₁</b><br><br>' +
        'The first term measures <b>fit quality</b> (how well the model matches the data). The second term enforces <b>sparsity</b> (prefer fewer, cleaner events). The parameter <b>λ</b> controls the balance between them.',
    },
    // Step 5: How the solver works
    {
      title: 'How the Solver Works',
      description:
        'CaTune uses <b>FISTA</b> (Fast Iterative Shrinkage-Thresholding Algorithm), a proximal gradient method. Each iteration:<br><br>' +
        '<b>1. Gradient step</b> — move toward a better fit to the data<br>' +
        '<b>2. Soft-thresholding</b> — shrink small values to zero, enforcing sparsity<br>' +
        '<b>3. Momentum</b> — Nesterov acceleration for faster convergence<br><br>' +
        'The solver runs in a <b>Rust/WASM Web Worker</b> until the solution stabilizes or hits the iteration limit. Warm-start caching means small parameter changes converge faster than starting from scratch.',
    },
    // Step 6: What decay time really controls
    {
      title: 'What Decay Time Really Controls',
      description:
        '<b>Decay time (τ_decay)</b> sets how quickly the kernel returns to baseline.<br><br>' +
        'When τ_decay <b>matches</b> the true indicator dynamics, the solver cleanly separates individual events — each transient is explained by a brief burst of activity at the onset.<br><br>' +
        'When τ_decay is <b>too short</b>, the kernel decays faster than the real signal. The solver must <b>produce extra activity during the decay phase</b> to explain the lingering fluorescence. This creates artificial activity spread across the tail of each transient.',
      onPopoverRender: renderDecayComparison,
    },
    // Step 7: The delta function trap
    {
      title: 'The Delta Function Trap',
      description:
        "A critical insight: making the kernel <b>sharper and faster</b> will almost always <b>improve the solver's fit</b> (lower residuals, higher R²).<br><br>" +
        'As the kernel approaches a delta function, the deconvolved trace simply <b>mirrors the calcium dynamics</b> — including the full rise and decay tail. The fit looks great, but the result is meaningless.<br><br>' +
        'This is the trap <b>automated parameter optimization</b> falls into: it converges on kernels that are much too fast because the fit metric keeps improving. This is why CaTune does not auto-optimize kernel parameters.',
      onPopoverRender: renderDeltaTrap,
    },
    // Step 8: Why sparsity doesn't fix it
    {
      title: "Why Sparsity Doesn't Fix It",
      description:
        'When the deconvolved trace looks too dense with a fast kernel, the instinct is to <b>increase λ</b> (sparsity penalty) to force fewer events.<br><br>' +
        "This <b>masks the symptom</b> but doesn't fix the cause — the kernel shape is wrong. High λ with a too-fast kernel produces sparse but <b>arbitrarily-placed</b> events.<br><br>" +
        'The correct fix is always to <b>adjust the kernel</b> (primarily decay time) until deconvolved events align with the rise phase of calcium transients — not to compensate with sparsity.',
    },
    // Step 9: Reading the signs
    {
      title: 'Reading the Signs',
      description:
        'How to tell if your kernel is <b>too fast</b>:<br><br>' +
        '<b>1.</b> Deconvolved events (green) appear spread across the <b>entire duration</b> of calcium transients, not concentrated at the rise<br>' +
        '<b>2.</b> Residuals (red) are <b>suspiciously low</b> — near-zero residuals mean the model is fitting noise, not just signal<br>' +
        '<b>3.</b> The deconvolved trace <b>mirrors the shape</b> of the raw fluorescence<br><br>' +
        'If you see these signs, <b>increase decay time</b>.',
      onPopoverRender: renderGoodVsBad,
    },
    // Step 10: The role of noise filtering
    {
      title: 'The Role of Noise Filtering',
      description:
        'High-frequency noise creates <b>spurious transients</b> in the deconvolved trace. The <b>Noise Filter</b> applies a bandpass derived from your kernel parameters:<br><br>' +
        '• The <b>high-pass</b> removes slow drift (baseline)<br>' +
        '• The <b>low-pass</b> removes noise above what your calcium dynamics can produce<br><br>' +
        "Filtering is conservative — it won't change transient shapes — but it significantly cleans up the deconvolution.",
    },
    // Step 11: What deconvolved activity is
    {
      title: 'What Deconvolved Activity Is',
      description:
        'The deconvolved trace <b>s(t)</b> is, at best, a measure of underlying neural activity <b>scaled by an unknown factor</b>. The variable name <b>s</b> is a convention from the optimization literature — it does <b>not</b> stand for "spikes." The output is a continuous, graded signal, not a series of discrete events.<br><br>' +
        'The absolute amplitude of s(t) depends on indicator expression, imaging conditions, cell depth, and many other variables. It has <b>no fixed physical meaning</b>. Only <b>relative differences</b> within the same cell under the same conditions are meaningful.',
    },
    // Step 12: What deconvolved activity is NOT
    {
      title: 'What Deconvolved Activity Is NOT',
      description:
        'Critical limitations:<br><br>' +
        '<b>1.</b> s(t) is <b>not a spike train</b> — do not threshold it into binary events<br>' +
        '<b>2.</b> You cannot derive <b>spikes-per-second</b> or firing rates from it<br>' +
        '<b>3.</b> It assumes neural activity is within the <b>linear response range</b> of the indicator<br>' +
        '<b>4.</b> It assumes calcium dynamics are not significantly driven by <b>non-neural factors</b> (glial activity, neuromodulation)<br>' +
        '<b>5.</b> It assumes a <b>single uniform kernel</b> applies to all events in the cell<br><br>' +
        'Treat s(t) as a <b>continuous, relative measure</b> of activity — not a direct readout of spiking.',
    },
    // Step 13: Practical guidance
    {
      title: 'Practical Guidance',
      description:
        'Given these constraints:<br><br>' +
        '<b>1.</b> Use deconvolved traces for <b>relative comparisons</b> — event timing, relative amplitude changes, correlation between cells<br>' +
        '<b>2.</b> Report your <b>kernel parameters and CaTune version</b> in publications<br>' +
        '<b>3.</b> Check the <b>Community Parameters</b> tab for values others use with your indicator and brain region<br>' +
        '<b>4.</b> When in doubt, trust the <b>residuals</b> — they reveal whether the model captures the signal structure or is fitting noise',
    },
    // Step 14: Theory complete
    {
      title: 'Theory Complete',
      description:
        'You now understand the <b>mathematical foundations</b> of calcium deconvolution, the critical pitfalls of kernel selection, and how to properly interpret the results.<br><br>' +
        'This knowledge will help you make informed parameter choices and avoid common analysis errors. For hands-on practice, try the <b>Tuning Workflow</b> or <b>Advanced Techniques</b> tutorials.',
    },
  ],
};
