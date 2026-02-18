// TUTR-03: Advanced Techniques tutorial.
// Pure data definition -- no driver.js imports (TUTR-05 compliance).

import type { Tutorial } from '../types.ts';

export const advancedTutorial: Tutorial = {
  id: 'advanced',
  title: 'Advanced Techniques',
  description:
    'Covers advanced deconvolution concepts: fit quality diagnostics, parameter coupling, indicator-specific guidance, metrics, and common artifacts.',
  level: 'advanced',
  prerequisites: ['workflow'],
  estimatedMinutes: 4,
  steps: [
    // Step 1: Introduction (centered modal, no element)
    {
      title: 'Advanced Techniques',
      description:
        'This tutorial covers advanced deconvolution concepts: fit quality diagnostics, parameter coupling, indicator-specific guidance, metrics, and common artifacts.',
    },
    // Step 2: Residual pattern analysis
    {
      element: '[data-tutorial="zoom-window"]',
      title: 'Residual Pattern Analysis',
      description:
        'The red residual trace reveals model mismatches. Systematic positive bumps after peaks: decay too short. Negative dips before peaks: rise too long. Low-frequency waves: baseline drift (not a parameter issue). <b>Residuals should resemble noise. Near-zero residuals = overfitting. Visible transient shapes = underfitting.</b>',
      side: 'bottom',
    },
    // Step 3: Parameter coupling
    {
      element: '[data-tutorial="param-panel"]',
      title: 'Parameter Coupling',
      description:
        'Rise and decay times interact. <b>After adjusting decay, always re-check rise.</b> With longer decay, the model explains more variance, so you may need less sparsity. <b>Tune in order: decay \u2192 rise \u2192 lambda.</b>',
      side: 'left',
    },
    // Step 4: Indicator-specific guidance
    {
      element: '[data-tutorial="kernel-display"]',
      title: 'Indicator-Specific Guidance',
      description:
        'Different calcium indicators have different kinetics. <b>GCaMP6f:</b> fast, decay ~200\u2013400ms. <b>GCaMP6s:</b> slow, decay ~500\u20131500ms. <b>GCaMP7f:</b> medium-fast, decay ~300\u2013600ms. <b>jGCaMP8f:</b> ultra-fast, decay ~50\u2013200ms. Published kinetics may not match your exact experimental conditions (area, expression time, cell type). Use ranges as starting points and refine on your data.',
      side: 'right',
    },
    // Step 5: Recognizing artifacts
    {
      element: '[data-tutorial="zoom-window"]',
      title: 'Recognizing Artifacts',
      description:
        'Common artifacts that affect fitting: <b>Motion artifacts:</b> sharp, symmetric deflections (not calcium-shaped). <b>Photobleaching:</b> slow downward baseline trend. <b>Neuropil contamination:</b> broad, slow signals mixed with sharp events. These cannot be fixed by parameter tuning \u2014 they require preprocessing.',
      side: 'bottom',
    },
    // Step 6: Fast firing and overlapping events
    {
      element: '[data-tutorial="zoom-window"]',
      title: 'Fast Firing and Overlapping Events',
      description:
        'When neurons fire rapidly, calcium events overlap. The model handles this via superposition, but dense firing can make individual events hard to resolve. <b>Under big fluorescence events, try increasing decay time to reduce dense deconvolved activity</b> \u2014 increase as much as possible without making the fit too poor.',
      side: 'bottom',
    },
    // Step 7: Multi-cell consistency
    {
      element: '[data-tutorial="card-grid"]',
      title: 'Multi-Cell Consistency',
      description:
        'Some variation in fit quality across cells is normal \u2014 cells differ in baseline noise, activity rate, and expression level. Aim for parameters that work well for the majority. If a few cells look terrible, they may have issues unrelated to parameter choice (dead cells, out-of-focus, artifacts).',
      side: 'top',
    },
    // Step 8: Open sidebar for metrics
    {
      element: '[data-tutorial="sidebar-toggle"]',
      title: 'Open Metrics Panel',
      description:
        'Open the <b>Sidebar</b> and click the <b>Metrics</b> tab for quantitative fit quality assessment.',
      side: 'bottom',
    },
    // Step 9: Metrics dashboard
    {
      element: '[data-tutorial="metrics-panel"]',
      title: 'Metrics Dashboard',
      description:
        'The Metrics panel shows per-cell SNR, R\u00B2, and sparsity percentage. Sort by SNR to identify problem cells. <b>Consistent SNR across cells suggests your parameters generalize well.</b> Outlier cells may have issues unrelated to parameter choice.',
      side: 'left',
    },
    // Step 10: Sampling rate matters
    {
      element: '[data-tutorial="slider-decay"]',
      title: 'When Sampling Rate Matters',
      description:
        'If your sampling rate is low (e.g., 10 Hz), fast dynamics are undersampled and parameters may need to be wider to compensate. If your data was recorded at a different rate than entered, all parameter values will be off. Double-check your sampling rate setting.',
      side: 'right',
    },
    // Step 11: Publication-quality parameters
    {
      element: '[data-tutorial="export-panel"]',
      title: 'Publication-Quality Parameters',
      description:
        'For publications, report: rise time, decay time, lambda, sampling rate, and calcium indicator. Include the AR2 coefficients from the export JSON \u2014 these are the mathematically equivalent autoregressive representation used by most analysis pipelines. Always note the CaTune version.',
      side: 'top',
    },
    // Step 12: Completion (centered modal, no element)
    {
      title: 'Advanced Tutorial Complete',
      description:
        'You have covered advanced deconvolution techniques. Remember: the goal is parameters that produce clean deconvolved traces with residuals that look like noise across diverse cells. When in doubt, trust the residuals.',
    },
  ],
};
