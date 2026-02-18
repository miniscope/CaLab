// TUTR-01: Understanding Parameters tutorial.
// Pure data definition -- no driver.js imports (TUTR-05 compliance).

import type { Tutorial } from '../types.ts';

export const basicsTutorial: Tutorial = {
  id: 'basics',
  title: 'Understanding Parameters',
  description:
    'Learn the basics of calcium trace deconvolution: what each parameter controls and how to recognize a good fit.',
  level: 'beginner',
  prerequisites: [],
  estimatedMinutes: 3,
  steps: [
    // Step 1: Welcome (centered modal, no element)
    {
      title: 'Welcome to CaTune',
      description:
        'This tutorial teaches you the basics of calcium trace deconvolution \u2014 what each parameter controls and how to recognize a good fit.',
    },
    // Step 2: Cell card
    {
      element: '[data-tutorial="cell-card-active"]',
      title: 'Your Cell Card',
      description:
        'Each cell gets its own card with two charts: a minimap overview at the top showing the full recording, and a zoom window below for detailed inspection. Click any card to make it active.',
      side: 'bottom',
    },
    // Step 3: Zoom window with overlaid traces
    {
      element: '[data-tutorial="zoom-window"]',
      title: 'Reading the Traces',
      description:
        'The zoom window shows four overlaid signals. Top band: raw fluorescence (blue) with the model\u2019s reconvolution fit (orange). Below that: inferred deconvolved activity (green). At the bottom: residuals (red) \u2014 the difference between raw and fit. When the fit is good, residuals look like random noise.',
      side: 'bottom',
    },
    // Step 4: Decay slider
    {
      element: '[data-tutorial="slider-decay"]',
      title: 'Decay Time (tau_decay)',
      description:
        'Controls how quickly calcium decays after a neural event. This is the most important parameter \u2014 start here. Typical values: 200\u2013800ms for GCaMP6f, 400\u20131500ms for GCaMP7f. Too short: fit undershoots after peaks. Too long: fit is sluggish and bleeds into the next event.',
      side: 'right',
    },
    // Step 5: Rise slider
    {
      element: '[data-tutorial="slider-rise"]',
      title: 'Rise Time (tau_rise)',
      description:
        'Controls how quickly calcium rises at the onset of an event. Usually much shorter than decay (5\u201350ms). Fine-tune this after decay is set. Too short: sharp onset artifacts. Too long: fit lags behind the true rise.',
      side: 'right',
    },
    // Step 6: Lambda slider
    {
      element: '[data-tutorial="slider-lambda"]',
      title: 'Sparsity Penalty (lambda)',
      description:
        'Controls how many events the model detects. Higher lambda = fewer, cleaner events. Lower lambda = more events but also more noise. Start low and increase until noise spikes disappear from the green trace without losing real events.',
      side: 'right',
    },
    // Step 7: Kernel display
    {
      element: '[data-tutorial="kernel-display"]',
      title: 'Calcium Kernel Shape',
      description:
        'This shows the shape of a single calcium event as defined by your current rise and decay times. It is the \u201Ctemplate\u201D the model uses to find events in your data. The shape should match what a real calcium transient looks like for your indicator.',
      side: 'right',
    },
    // Step 8: Convergence indicator
    {
      element: '[data-tutorial="convergence-indicator"]',
      title: 'Solver Status',
      description:
        'Shows whether the deconvolution solver is still computing (Solving...) or has finished (Converged). When you adjust parameters, the solver re-runs. Wait for \u201CConverged\u201D before judging the fit quality.',
      side: 'bottom',
    },
    // Step 9: Good vs bad fit
    {
      element: '[data-tutorial="param-panel"]',
      title: 'Good Fit vs Bad Fit',
      description:
        'A good fit: orange closely tracks blue peaks, green trace has clean events, and red residuals look like noise. A bad fit: orange misses peaks, green trace is noisy or has missing events, and residuals show structured patterns. Try different parameter values to see the difference.',
      side: 'left',
    },
    // Step 10: Pin for comparison
    {
      element: '[data-tutorial="pin-snapshot"]',
      title: 'Compare Parameters',
      description:
        'Use \u201CPin for Comparison\u201D to save the current fit as a faded overlay. Then adjust parameters and see the new fit alongside the old one \u2014 a quick way to judge if your changes improved things.',
      side: 'bottom',
    },
    // Step 11: Completion (centered modal, no element)
    {
      title: 'Basics Complete',
      description:
        'You now understand the basic parameters and what to look for. Next, try the \u201CGuided Tuning Workflow\u201D tutorial to learn the recommended step-by-step tuning process.',
    },
  ],
};
