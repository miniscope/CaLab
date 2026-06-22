// CADECON-TUTR-04: Reading Convergence & Results.

import type { Tutorial } from '@calab/tutorials';

export const interpretingTutorial: Tutorial = {
  id: 'interpreting',
  title: 'Reading Convergence & Results',
  description:
    'Use CaDecon\u2019s diagnostic panels to tell a good run from a bad one: the convergence tabs, the learned kernel, iteration scrubbing, residuals, and when to adjust algorithm settings or re-run.',
  level: 'advanced',
  prerequisites: ['basics'],
  estimatedMinutes: 5,
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
        'Click through the tabs. <b>Kernel</b> and <b>PVE</b> are your first checks: the kernel shape should stop changing and PVE should plateau. <b>Threshold</b> and <b>Alpha</b> should settle rather than drift. <b>Warning signs:</b> values still moving at the iteration cap (raise Max Iterations), or a sharp reset mid-run followed by divergence (often a low-SNR or may be an unlucky subset choice.) To remedy this, try higher coverage or re-tiling).',
      side: 'bottom',
      popoverClass: 'driver-popover--wide',
    },
    // Step 3: Kernel quality
    {
      element: '[data-tutorial="kernel-display"]',
      title: 'Judging Kernel Quality',
      description:
        'The learned kernel should look like a real calcium transient: a fast rise to a single peak, then a smooth decay. The per-subset free-kernel curves should <b>cluster tightly</b> around the fitted model. Bumpy, multi-peaked, or widely scattered curves mean the subsets disagreed which makes the kernel uncertain. If this is the case, don\u2019t over-trust the deconvolved output. If ground truth is available (like in demo data), it overlays here for comparison.',
      side: 'left',
    },
    // Step 4: Iteration selector
    {
      element: '[data-tutorial="iteration-scrubber"]',
      title: 'Moving Through Iterations',
      description:
        'The iteration selector lets you scroll through the results at each iteration. Drag back and forth to watch the kernel and fit evolve iteration by iteration, then pop back to <b>Latest</b>. This is the best way to <b>diagnose a reset</b>: if the fit looked better at an earlier iteration than at the end, the run may have drifted. That may be a sign to lower Max Iterations or change convergence tolerance.',
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
        'Most runs need no changes, but here are a few scenarios where you might want to adjust the settings:<br>' +
        '<ul>' +
        '<li>Raise <b>Max Iterations</b> if convergence is still moving at the cap.</li>' +
        '<li>Make <b>Convergence Tol</b> smaller for a stricter stop, or larger to stop earlier.</li>' +
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
    // Step 8: Completion
    {
      title: 'Results Reading Complete',
      description:
        'Yay! You have completed all tutorials and are ready to run and interpret your data! As a final reminder, confirm convergence using the tabs, check that the kernel clusters tightly, move through iterations to rule out drift, and trust the residuals over any single fit. When a run looks wrong, the fix is usually altering how you set subsets or increasing the maximum number of iterations.',
    },
  ],
};
