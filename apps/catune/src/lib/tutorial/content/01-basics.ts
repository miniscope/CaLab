// TUTR-01: Understanding Parameters tutorial.
// Pure data definition -- no driver.js imports (TUTR-05 compliance).

import type { Tutorial } from '@calab/tutorials';

export const basicsTutorial: Tutorial = {
  id: 'basics',
  title: 'Understanding Parameters',
  description:
    'Learn the basics of calcium trace deconvolution: cell cards, trace reading, and what each parameter controls.',
  level: 'beginner',
  prerequisites: [],
  estimatedMinutes: 5,
  steps: [
    // Step 1: Welcome (centered modal, no element)
    {
      title: 'Welcome to CaTune',
      description:
        'This tutorial teaches you the basics of calcium trace deconvolution \u2014 how to navigate cell cards, read traces, and understand what each parameter controls.',
    },
    // Step 2: Header bar
    {
      element: '[data-tutorial="header-bar"]',
      title: 'The Dashboard',
      description:
        'The header shows your dataset info: filename, cell count, timepoints, sampling rate, and duration. On the right you\u2019ll find action buttons for tutorials, the analysis sidebar, feedback, and switching datasets.',
      side: 'bottom',
    },
    // Step 3: Cell card
    {
      element: '[data-tutorial="card-grid"]',
      title: 'Your Cell Cards',
      description:
        'Each cell gets its own card with a minimap overview at the top and a zoom window below. Click any card to select it as the active cell.',
      side: 'bottom',
    },
    // Step 4: Minimap
    {
      element: '[data-tutorial="card-grid"]',
      title: 'The Minimap',
      description:
        'At the top of each card is the minimap \u2014 a full-recording overview. The shaded region is your zoom window. <b>Click anywhere on the minimap</b> to jump to that timepoint, or <b>drag</b> to reposition the zoom window.',
      side: 'bottom',
    },
    // Step 5: Zoom window
    {
      element: '[data-tutorial="card-grid"]',
      title: 'The Zoom Window',
      description:
        'Below the minimap is the zoom window showing a detailed view of the selected time range. <b>Drag left/right to pan</b> through the recording. <b>Ctrl+Scroll</b> (or Cmd+Scroll) to zoom in and out.',
      side: 'bottom',
    },
    // Step 6: Reading the traces
    {
      element: '[data-tutorial="card-grid"]',
      title: 'Reading the Traces',
      description:
        'Four trace bands are overlaid in the zoom window: raw fluorescence (blue) with the model\u2019s fit (orange) on top, inferred deconvolved activity (green) in the middle, and residuals (red) at the bottom. When the fit is good, residuals look like random noise.',
      side: 'bottom',
    },
    // Step 7: Solver status indicator
    {
      element: '[data-tutorial="card-grid"]',
      title: 'Solver Status',
      description:
        'The badge in each card header shows solver state. The colored dot indicates: <b>green</b> = solver finished, <b>yellow</b> = solver running, <b>red</b> = solver needs to run. When finished it displays the SNR value. Wait for the solver to complete before judging the fit.',
      side: 'bottom',
    },
    // Step 8: Resize handle
    {
      element: '[data-tutorial="resize-handle"]',
      title: 'Card Height',
      description:
        'Drag the handle at the bottom of any card to resize all cards vertically. Taller cards make it easier to inspect fine trace details.',
      side: 'top',
    },
    // Step 9: Legend bar
    {
      element: '[data-tutorial="legend-bar"]',
      title: 'Trace Legend',
      description:
        '<b>Click any legend item to toggle that trace on or off.</b> The \u201C?\u201D button explains what each trace represents. Hiding traces you\u2019re not focused on reduces visual clutter.',
      side: 'bottom',
    },
    // Step 10: Grid columns
    {
      element: '[data-tutorial="grid-columns"]',
      title: 'Grid Layout',
      description:
        'Use +/\u2212 to adjust the number of columns (1\u20136). Fewer columns means larger cards for detailed inspection. More columns lets you compare many cells at once.',
      side: 'bottom',
    },
    // Step 11: Decay slider
    {
      element: '[data-tutorial="slider-decay"]',
      title: 'Decay Time (tau_decay)',
      description:
        'The most important parameter \u2014 start here. Controls how quickly calcium decays after a neural event. Too short: the solver places extra activity during the decay phase to explain lingering signal (overfitting). Too long: fit is sluggish and misses fast events. <b>Deconvolved activity should primarily appear during the rise, not spread across the whole decay.</b>',
      side: 'right',
    },
    // Step 12: Rise slider
    {
      element: '[data-tutorial="slider-rise"]',
      title: 'Rise Time (tau_rise)',
      description:
        'Controls how quickly calcium rises at event onset. Usually much shorter than decay. Fine-tune after decay is set. Note: <b>changing rise slightly changes optimal decay</b> \u2014 they\u2019re coupled, so re-check decay after adjusting rise.',
      side: 'right',
    },
    // Step 13: Lambda slider
    {
      element: '[data-tutorial="slider-lambda"]',
      title: 'Sparsity Penalty (lambda)',
      description:
        'Controls event count. Start low and increase until noise artifacts disappear from the green trace without losing real events. A value of 1 is a good starting point. The green deconvolved trace should show clean, sharp peaks at real events with a quiet baseline between them. If the reconvolved fit peak starts decreasing away from the raw trace as you increase lambda, your sparsity is too high. <b>Prefer adjusting decay time over relying on high sparsity</b> to control overfitting. Increasing decay can help reduce dense deconvolved activity under big fluorescence events. Most cells will respond well to small sparsity values, but a small percentage of cells may be too noisy for reliable deconvolution \u2014 don\u2019t overfit noisy cells, focus on the average-looking cell.',
      side: 'right',
    },
    // Step 14: Kernel display
    {
      element: '[data-tutorial="kernel-display"]',
      title: 'Calcium Kernel Shape',
      description:
        'The template the model uses to find events in your data. It should match what a real calcium transient looks like for your indicator. Peak time and half-decay time are shown in the annotations.',
      side: 'right',
    },
    // Step 15: Good vs bad fit
    {
      element: '[data-tutorial="card-grid"]',
      title: 'Good Fit vs Bad Fit',
      description:
        '<b>Good:</b> orange tracks blue peaks, green deconvolved activity appears primarily during the rise of calcium events (activity during the decay suggests additional neural activity or an extended response), red looks like noise. <b>Bad:</b> orange misses or undershoots peaks, the orange tail overshoots the raw data, green has activity spread beyond the actual transients, red shows structured patterns.',
      side: 'left',
    },
    // Step 16: Pin for comparison
    {
      element: '[data-tutorial="pin-snapshot"]',
      title: 'Pin for Comparison',
      description:
        'Save the current fit as a dashed overlay, then adjust parameters. The overlay lets you quickly judge whether changes improved the fit.',
      side: 'bottom',
    },
    // Step 17: Completion (centered modal, no element)
    {
      title: 'Basics Complete',
      description:
        'You now understand the cell card layout, traces, and parameter controls. Next, try the \u201CGuided Tuning Workflow\u201D tutorial to learn the recommended step-by-step tuning process.',
    },
  ],
};
