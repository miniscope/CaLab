// CADECON-TUTR-04: Reading Convergence & Results.

import type { Tutorial } from '@calab/tutorials';

export const interpretingTutorial: Tutorial = {
  id: 'interpreting',
  title: 'Reading Convergence & Results',
  description:
    'Use CaDecon\u2019s diagnostic panels to tell a good run from a bad one: the convergence tabs, the learned kernel, iteration scrubbing, residuals, and when to adjust algorithm settings or re-run.',
  level: 'advanced',
  prerequisites: ['basics'],
  estimatedMinutes: 6,
  steps: [
    // Step 1: Introduction
    {
      title: 'Reading Convergence & Results',
      description:
        'A CaDecon run produces a lot of diagnostics. This tutorial shows how to read them together to answer one question: <b>How do I tell if a run converged to a proper kernel and fit?</b>',
    },
    // Step 2: Convergence tab
    {
      element: '[data-tutorial="kernel-convergence"]',
      title: 'Signs of Healthy Convergence',
      description:
        'Start on the <b>Asymptote</b> tab — its four small charts are your first check. Kernel shape (peak time &amp; FWHM), kernel-fit R², reconstruction PVE, and activity stability should all <b>flatten toward a plateau</b> as the run settles; the green marker shows the iteration where CaDecon declared convergence. The <b>Kernel</b> tab shows the shape itself over iterations, and <b>Distributions</b> shows the per-cell alpha, PVE, and event-rate spread. <b>Warning signs:</b> curves still moving when the run ends (the kernel never stabilized — usually low SNR or an unlucky subset draw; try higher coverage or re-tiling), or a sharp reset mid-run followed by divergence.',
      side: 'bottom',
      popoverClass: 'driver-popover--wide',
    },
    // Step 3: Kernel quality
    {
      element: '[data-tutorial="kernel-display"]',
      title: 'Judging Kernel Quality',
      description:
        'The learned kernel should look like a real calcium transient: a fast rise to a single peak, then a smooth decay. The per-subset free-kernel curves should <b>cluster tightly</b> around the fitted model. Bumpy, multi-peaked, or widely scattered curves mean the subsets disagreed which makes the kernel uncertain. If this is the case, don\u2019t over-trust the deconvolved output. Watch for a <b>degenerate-fit warning</b> here (e.g. \u201c\u26a0 2/8 fits degenerate\u201d): it means some subsets produced no usable calcium shape \u2014 typically the subsets that caught mostly noise \u2014 which is a cue to raise coverage or re-tile. If ground truth is available (like in demo data), it overlays here for comparison.',
      side: 'left',
    },
    // Step 4: Iteration selector
    {
      element: '[data-tutorial="iteration-scrubber"]',
      title: 'Moving Through Iterations',
      description:
        'The iteration selector lets you scroll through the results at each iteration. Drag back and forth to watch the kernel and fit evolve iteration by iteration, then pop back to <b>Latest</b>. This is the best way to <b>diagnose drift</b>: if the fit looked better at an earlier iteration than at the end, the run kept iterating past its best point. Loosening the <b>Convergence Tolerance</b> lets the run settle and stop sooner, before it drifts.',
      side: 'top',
    },
    // Step 5: Residuals in the trace inspector
    {
      element: '[data-tutorial="trace-viewer"]',
      title: 'Trusting the Residuals',
      description:
        'In the Trace Inspector, enable the <b>residual</b> band. Good residuals look like flat noise with no structure. <b>Bumps in the residual trace</b> that look like they are tracking events mean the kernel is not a good fit for that cell. <b>Near-zero residuals</b> everywhere can mean the model is fitting noise, not just the signal. If the residuals are near zero, check that the deconvolved activity is concentrated at event onsets.',
      side: 'top',
      popoverClass: 'driver-popover--wide',
    },
    // Step 6: When to change algorithm settings
    {
      element: '[data-tutorial="algorithm-settings"]',
      title: 'When to Adjust Settings',
      description:
        'Most runs need no changes, but here are a few scenarios where you might adjust the settings:<br>' +
        '<ul>' +
        '<li><b>Convergence Tolerance</b> is the real stopping control: loosen it to stop sooner (helpful when a run drifts after peaking), tighten it to keep refining longer.</li>' +
        '<li>Leave <b>Max Iterations</b> at its default. It is only a safety cap that halts a run which never settles — not a tuning knob. If runs regularly hit the cap, the fix is better data coverage (more subsets or coverage), not a higher cap.</li>' +
        '<li>Enable the <b>High-Pass Filter</b> if baseline drift is contaminating the fit.</li>' +
        '<li>Enable the <b>Low-Pass Filter</b> for very noisy recordings.</li>' +
        '<li>Raise the <b>Upsample Target</b> only if your sampling rate is low relative to event kinetics.</li>' +
        '</ul>',
      side: 'right',
    },
    // Step 7: Submitting to the community
    {
      element: '[data-tutorial="submit-panel"]',
      title: 'Sharing Your Kernel',
      description:
        'Once a run has converged to a kernel you trust, you can submit it to the community database. It includes the kernel parameters (tau_rise, tau_decay, beta) plus other stats (median alpha, PVE, event rate, cell count). This helps others find good starting points for the same indicator and brain region. Browse existing submissions from the <b>Community</b> sidebar tab.',
      side: 'top',
    },
    // Step 8: Going further with the Python package
    {
      title: 'Going Further: the Python Package',
      description:
        'Everything CaDecon does in the browser is also available from Python. The <code>calab</code> package (<code>pip install calab</code>) ships the same native solver, plus utilities for loading CaImAn and Minian data, simulating traces, and running batch deconvolution from scripts — handy when you have many recordings to process. See the full API reference, guides, and CLI at <b>calab.readthedocs.io</b>.',
    },
    // Step 9: Completion
    {
      title: 'Results Reading Complete',
      description:
        'You now have what you need to run and interpret your data. As a final reminder: confirm convergence using the tabs, check that the per-subset kernels cluster tightly, move through iterations to rule out drift, and trust the residuals over any single fit. When a run looks wrong, the fix is usually in how you set up the subsets rather than in the algorithm settings.',
    },
  ],
};
