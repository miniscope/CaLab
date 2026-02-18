// TUTR-02: Guided Tuning Workflow tutorial.
// Pure data definition -- no driver.js imports (TUTR-05 compliance).

import type { Tutorial } from '../types.ts';

export const workflowTutorial: Tutorial = {
  id: 'workflow',
  title: 'Guided Tuning Workflow',
  description:
    'Walk through the recommended step-by-step tuning process used by the Aharoni Lab, adjusting parameters on your own data.',
  level: 'intermediate',
  prerequisites: ['basics'],
  estimatedMinutes: 7,
  steps: [
    // Step 1: Introduction (centered modal, no element)
    {
      title: 'Guided Tuning Workflow',
      description:
        'This tutorial walks you through the recommended tuning workflow used by the Aharoni Lab. You will adjust parameters step by step on your own data.',
    },
    // Step 2: Pick a starting cell
    {
      element: '[data-tutorial="cell-selector"]',
      title: 'Step 1: Pick a Good Starting Cell',
      description:
        'Start with a cell that has clear, isolated events visible in the raw trace. Use \u201CTop Active\u201D mode to find cells with strong activity. Click a card below to switch cells.',
      side: 'top',
    },
    // Step 3: Look for clean events
    {
      element: '[data-tutorial="card-grid"]',
      title: 'Look for Clean Events',
      description:
        'Scan the raw trace (blue) for sharp, well-separated peaks. Avoid cells dominated by noise or slow baseline drift. A cell with a few clear events is ideal for initial tuning.',
      side: 'bottom',
    },
    // Step 4: Tune decay time (interactive)
    {
      element: '[data-tutorial="slider-decay"]',
      title: 'Step 2: Tune Decay Time',
      description:
        'Decay has the biggest visual impact. Find clean, small-amplitude calcium events first. Drag the slider until the fit\u2019s falling edge matches the filtered trace\u2019s falling edge after each peak. Try it now.',
      side: 'right',
      waitForAction: 'slider-change',
      disableActiveInteraction: false,
    },
    // Step 5: Check the fit
    {
      element: '[data-tutorial="card-grid"]',
      title: 'Check the Fit',
      description:
        'Look at how the orange fit line follows the blue raw trace after peaks. The tails should line up. If the fit drops too fast, increase decay. If it lingers too long, decrease decay.',
      side: 'bottom',
    },
    // Step 6: Check residuals
    {
      element: '[data-tutorial="card-grid"]',
      title: 'Step 3: Check Residuals',
      description:
        'Look at the red residual trace at the bottom. Residuals should resemble the noise characteristics of your recording. <b>Near-zero residuals = overfitting.</b> Visible transient shapes in residuals = underfitting. Good residuals are flat noise with no structure.',
      side: 'bottom',
    },
    // Step 7: Consider noise filtering (interactive)
    {
      element: '[data-tutorial="noise-filter"]',
      title: 'Step 3b: Consider Noise Filtering',
      description:
        'Noise leads to deconvolution artifacts. Enable the <b>Noise Filter</b> to apply a bandpass filter derived from your kernel parameters. Filtering is conservative \u2014 it removes high-frequency noise without changing rise time dynamics. <b>Toggle it on to try.</b>',
      side: 'right',
      waitForAction: 'filter-toggle',
      disableActiveInteraction: false,
    },
    // Step 8: Open sidebar for spectrum
    {
      element: '[data-tutorial="sidebar-toggle"]',
      title: 'Open the Sidebar',
      description:
        'Click the <b>Sidebar</b> button to open the analysis panel. It contains Spectrum, Metrics, and Community tabs.',
      side: 'bottom',
    },
    // Step 9: Select the Spectrum tab
    {
      element: '[data-tutorial="sidebar-tab-spectrum"]',
      title: 'Select the Spectrum Tab',
      description:
        'The sidebar defaults to the Community tab. <b>Click the Spectrum tab</b> to see frequency analysis for your data.',
      side: 'bottom',
    },
    // Step 10: Check the spectrum
    {
      element: '[data-tutorial="spectrum-panel"]',
      title: 'Check the Spectrum',
      description:
        'The power spectral density shows your data\u2019s frequency content. When Noise Filter is on, dashed lines mark the bandpass cutoffs (HP and LP). The passband should preserve your calcium signal frequencies while rejecting noise.',
      side: 'left',
    },
    // Step 10: Fine-tune rise time (interactive)
    {
      element: '[data-tutorial="slider-rise"]',
      title: 'Step 4: Fine-Tune Rise Time',
      description:
        'Now adjust the rise time. This is subtle \u2014 it affects the onset of each event. Watch the leading edge of peaks in the fit. Drag to adjust.',
      side: 'right',
      waitForAction: 'slider-change',
      disableActiveInteraction: false,
    },
    // Step 12: Check rise slopes
    {
      element: '[data-tutorial="card-grid"]',
      title: 'Check Rise Slopes',
      description:
        'Zoom into a peak onset. The orange fit should match the blue trace\u2019s upward slope. If the fit rises too slowly, decrease rise time. If it overshoots, increase it slightly. Note: changing rise time may slightly affect the optimal decay \u2014 re-check.',
      side: 'bottom',
    },
    // Step 12: Add sparsity (interactive)
    {
      element: '[data-tutorial="slider-lambda"]',
      title: 'Step 5: Add Sparsity',
      description:
        'Increase lambda to clean up the deconvolved trace. Start low and increase until noise spikes disappear from the green trace. Stop before real events start vanishing. Drag to adjust.',
      side: 'right',
      waitForAction: 'slider-change',
      disableActiveInteraction: false,
    },
    // Step 14: Check deconvolved quality
    {
      element: '[data-tutorial="card-grid"]',
      title: 'Check Deconvolved Quality',
      description:
        'The green deconvolved trace should show clean, sharp peaks at real events with a quiet baseline between them. If the baseline is still noisy, increase lambda. If events are disappearing, decrease it.',
      side: 'bottom',
    },
    // Step 14: Validate across cells
    {
      element: '[data-tutorial="card-grid"]',
      title: 'Step 6: Validate Across Cells',
      description:
        'Good parameters should work across diverse cells, not just one. Check a variety of different calcium signals \u2014 traces with overlapping events, large amplitude events, and different cell types.',
      side: 'top',
    },
    // Step 15: Check different cell types
    {
      element: '[data-tutorial="cell-selector"]',
      title: 'Check Different Cell Types',
      description:
        'Switch between \u201CTop Active\u201D, \u201CRandom\u201D, and \u201CManual\u201D selection to test parameters on cells with different activity levels. Parameters that only work on high-SNR cells may need adjustment.',
      side: 'top',
    },
    // Step 16: Compare iterations
    {
      element: '[data-tutorial="pin-snapshot"]',
      title: 'Step 7: Compare Iterations',
      description:
        'Pin your current parameters, then make adjustments. The dashed overlay lets you see whether your changes improved the fit. This is especially useful for subtle lambda adjustments.',
      side: 'bottom',
    },
    // Step 17: Export
    {
      element: '[data-tutorial="export-panel"]',
      title: 'Step 8: Export When Satisfied',
      description:
        'Once your parameters produce good fits across diverse cells, export them. The JSON file includes all parameter values, AR2 coefficients for downstream analysis, and metadata about your dataset.',
      side: 'top',
    },
    // Step 18: Completion (centered modal, no element)
    {
      title: 'Workflow Complete',
      description:
        'Excellent! You have completed the guided tuning workflow. Your exported parameters can be used directly in analysis pipelines. For deeper insights, try the \u201CAdvanced Techniques\u201D tutorial.',
    },
  ],
};
