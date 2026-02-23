// TUTR-05: Deconvolution Theory tutorial.
// Standalone conceptual tutorial covering the math, solver mechanics,
// critical pitfalls, and how to interpret deconvolution results.
// All steps are centered modals (no element field).
// Pure data definition -- no driver.js imports (TUTR-05 compliance).

import type { Tutorial } from '@calab/tutorials';
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
  estimatedMinutes: 7,
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
        '<b>F(t) = (s \u2217 k)(t) + b(t) + \u03B5(t)</b><br><br>' +
        'where <b>s</b> is neural activity, <b>k</b> is the calcium kernel, <b>b</b> is baseline drift, and <b>\u03B5</b> is noise. Deconvolution aims to recover <b>s</b> from <b>F</b>.',
    },
    // Step 3: The calcium kernel
    {
      title: 'The Calcium Kernel',
      description:
        'Each action potential triggers a calcium influx that rises quickly and decays exponentially. The kernel <b>k(t)</b> models this shape using two time constants:<br><br>' +
        '<b>\u03C4_rise</b> — onset speed (how fast calcium appears)<br>' +
        '<b>\u03C4_decay</b> — return to baseline (how fast calcium clears)<br><br>' +
        'The kernel shape:<br>' +
        '<b>k(t) = e<sup>\u2212t/\u03C4_decay</sup> \u2212 e<sup>\u2212t/\u03C4_rise</sup></b><br><br>' +
        'This is the <b>template</b> the solver uses to match events in your data. Getting its shape right is the single most critical step in the entire analysis.',
      onPopoverRender: renderKernelShape,
    },
    // Step 4: The deconvolution problem
    {
      title: 'The Deconvolution Problem',
      description:
        'Given the observed fluorescence <b>F(t)</b> and a kernel <b>k(t)</b>, the goal is to recover the underlying activity <b>s(t)</b>. This is an <b>inverse problem</b>: undo the convolution to find what neural activity, when convolved with the kernel, best explains the data.<br><br>' +
        'The solver minimizes:<br>' +
        '<b>\u2016F \u2212 k\u2217s\u2016\u00B2 + \u03BB\u2016s\u2016\u2081</b><br><br>' +
        'The first term measures <b>fit quality</b> (how well the model matches the data). The second term enforces <b>sparsity</b> (prefer fewer, cleaner events). The parameter <b>\u03BB</b> controls the balance between them.',
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
        '<b>Decay time (\u03C4_decay)</b> sets how quickly the kernel returns to baseline.<br><br>' +
        'When \u03C4_decay <b>matches</b> the true indicator dynamics, the solver cleanly separates individual events — each transient is explained by a brief burst of activity at the onset.<br><br>' +
        'When \u03C4_decay is <b>too short</b>, the kernel decays faster than the real signal. The solver must <b>produce extra activity during the decay phase</b> to explain the lingering fluorescence. This creates artificial activity spread across the tail of each transient.',
      onPopoverRender: renderDecayComparison,
    },
    // Step 7: The Delta Function Trap (merged: delta function trap + why sparsity doesn't fix it)
    {
      title: 'The Delta Function Trap',
      description:
        "A critical insight: making the kernel <b>sharper and faster</b> will almost always <b>improve the solver's fit</b> (lower residuals, higher R\u00B2).<br><br>" +
        'As the kernel approaches a delta function, the deconvolved trace simply <b>mirrors the calcium dynamics</b> — including the full rise and decay tail. The fit looks great, but the result is meaningless.<br><br>' +
        'This is the trap <b>automated parameter optimization</b> falls into: it converges on kernels that are much too fast because the fit metric keeps improving. This is why CaTune does not auto-optimize kernel parameters.<br><br>' +
        'The instinct is to <b>increase \u03BB</b> (sparsity) to compensate for the dense activity, but this <b>masks the symptom</b> without fixing the cause — the kernel shape is wrong. High \u03BB with a too-fast kernel produces sparse but arbitrarily-placed events. The correct fix is always to <b>adjust the kernel</b> (primarily decay time).',
      onPopoverRender: renderDeltaTrap,
    },
    // Step 8: Reading the signs
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
    // Step 9: The role of noise filtering
    {
      title: 'The Role of Noise Filtering',
      description:
        'High-frequency noise creates <b>spurious transients</b> in the deconvolved trace. The <b>Noise Filter</b> applies a bandpass derived from your kernel parameters:<br><br>' +
        '\u2022 The <b>high-pass</b> removes slow drift (baseline)<br>' +
        '\u2022 The <b>low-pass</b> removes noise above what your calcium dynamics can produce<br><br>' +
        "Filtering is conservative — it won't change transient shapes — but it significantly cleans up the deconvolution.",
    },
    // Step 10: What Deconvolved Activity IS (and IS NOT) (merged: what it is + what it is not)
    {
      title: 'What Deconvolved Activity IS (and IS NOT)',
      description:
        'The deconvolved trace <b>s(t)</b> is, at best, a <b>probable neural activity rate</b> scaled by an <b>unknown factor</b>. The variable name <b>s</b> is a convention from the optimization literature — it does <b>not</b> stand for "spikes." The output is a continuous, graded signal, not a series of discrete events.<br><br>' +
        'The absolute amplitude of s(t) depends on indicator expression, imaging conditions, cell depth, and many other variables. It has <b>no fixed physical meaning</b>. The unknown scalar factor can <b>differ between cells</b> and can <b>change over time</b> across sessions. Only <b>relative differences</b> within the same cell under the same conditions are meaningful.<br><br>' +
        '<b>Critical limitations:</b><br>' +
        '<b>1.</b> s(t) is <b>not a spike train</b> — binarizing (thresholding into 0/1) discards meaningful amplitude information and should be avoided in almost all cases<br>' +
        '<b>2.</b> You cannot derive <b>spikes-per-second</b> or firing rates from it<br>' +
        '<b>3.</b> It assumes neural activity is within the <b>linear response range</b> of the indicator<br>' +
        '<b>4.</b> It assumes calcium dynamics are not significantly driven by <b>non-neural factors</b> (glial activity, neuromodulation)<br>' +
        '<b>5.</b> It assumes a <b>single uniform kernel</b> applies to all events in the cell<br><br>' +
        'Treat s(t) as a <b>continuous, relative measure</b> of activity — not a direct readout of spiking.',
      popoverClass: 'driver-popover--wide',
    },
    // Step 11: Comparing Results & Avoiding Common Mistakes (merged: cross-cell comparison + binarization warning)
    {
      title: 'Comparing Results & Avoiding Common Mistakes',
      description:
        'The unknown scalar factor that relates s(t) to true neural activity can <b>differ between cells</b> (due to indicator expression, optical path, cell depth) and can <b>evolve over time</b> across sessions (photobleaching, expression changes).<br><br>' +
        '<b>Within a single cell in a single session</b>, the unknown scalar is generally stable — so within-trace comparisons of amplitude and timing are meaningful.<br><br>' +
        '<b>Across cells or sessions</b>, direct amplitude comparison should generally <b>never</b> be done without careful normalization. Even with normalization, extreme caution is needed — clever normalization schemes can help but are very limited and cannot fully resolve the unknown scaling differences.<br><br>' +
        'The deconvolved output should never be treated as "spikes." Researchers often threshold out of habit from electrophysiology, but calcium deconvolution is <b>fundamentally different</b>: the temporal resolution and signal characteristics make binary discretization inappropriate. If you need discrete events for a specific analysis, consider whether the continuous signal would serve your question better — in most cases, it will.',
      popoverClass: 'driver-popover--wide',
    },
    // Step 12: Practical guidance
    {
      title: 'Practical Guidance',
      description:
        'Given these constraints:<br><br>' +
        '<b>1.</b> Use deconvolved traces for <b>relative comparisons</b> — event timing, relative amplitude changes, correlation between cells<br>' +
        '<b>2.</b> Report your <b>kernel parameters and CaTune version</b> in publications<br>' +
        '<b>3.</b> Check the <b>Community Parameters</b> tab for values others use with your indicator and brain region<br>' +
        '<b>4.</b> When in doubt, trust the <b>residuals</b> — they reveal whether the model captures the signal structure or is fitting noise',
    },
    // Step 13: Theory complete
    {
      title: 'Theory Complete',
      description:
        'You now understand the <b>mathematical foundations</b> of calcium deconvolution, the critical pitfalls of kernel selection, and how to properly interpret the results.<br><br>' +
        'This knowledge will help you make informed parameter choices and avoid common analysis errors. For hands-on practice, try the <b>Tuning Workflow</b> or <b>Advanced Techniques</b> tutorials.',
    },
  ],
};
