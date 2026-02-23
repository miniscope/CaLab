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
  estimatedMinutes: 4,
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
    // Step 3: Cell Card Anatomy (merged: card overview + minimap + zoom window)
    {
      element: '[data-tutorial="card-grid"]',
      title: 'Cell Card Anatomy',
      description:
        'Each cell gets its own card with a <b>minimap</b> overview at the top and a <b>zoom window</b> below. Click any card to select it as the active cell.<br><br>' +
        'The minimap shows the full recording. The shaded region is your zoom window \u2014 <b>click anywhere on the minimap</b> to jump to that timepoint, or <b>drag</b> to reposition.<br><br>' +
        'The zoom window shows a detailed view of the selected time range. <b>Drag left/right to pan</b> through the recording. <b>Ctrl+Scroll</b> (or Cmd+Scroll) to zoom in and out.',
      side: 'bottom',
      popoverClass: 'driver-popover--wide',
    },
    // Step 4: Traces & Solver Status (merged: trace reading + solver status + good-fit hint)
    {
      element: '[data-tutorial="card-grid"]',
      title: 'Traces & Solver Status',
      description:
        'Four trace bands are overlaid in the zoom window: raw fluorescence (blue) with the model\u2019s fit (orange) on top, inferred deconvolved activity (green) in the middle, and residuals (red) at the bottom. When the fit is good, orange tracks blue peaks and residuals look like random noise.<br><br>' +
        'The badge in each card header shows solver state. The colored dot indicates: <b>green</b> = solver finished, <b>yellow</b> = solver running, <b>red</b> = solver needs to run. When finished it displays the SNR value. Wait for the solver to complete before judging the fit.',
      side: 'bottom',
      popoverClass: 'driver-popover--wide',
    },
    // Step 5: Resize handle
    {
      element: '[data-tutorial="resize-handle"]',
      title: 'Card Height',
      description:
        'Drag the handle at the bottom of any card to resize all cards vertically. Taller cards make it easier to inspect fine trace details.',
      side: 'top',
    },
    // Step 6: View Controls (merged: legend bar + grid columns)
    {
      element: '[data-tutorial="legend-bar"]',
      title: 'View Controls',
      description:
        '<b>Click any legend item to toggle that trace on or off.</b> The \u201C?\u201D button explains what each trace represents. Hiding traces you\u2019re not focused on reduces visual clutter.<br><br>' +
        'Use the +/\u2212 buttons to adjust the number of grid columns (1\u20136). Fewer columns means larger cards for detailed inspection; more columns lets you compare many cells at once.',
      side: 'bottom',
    },
    // Step 7: Decay slider (+ kernel shape info absorbed from former kernel display step)
    {
      element: '[data-tutorial="slider-decay"]',
      title: 'Decay Time (tau_decay)',
      description:
        'The most important parameter \u2014 start here. Controls how quickly calcium decays after a neural event. Too short: the solver places extra activity during the decay phase to explain lingering signal (overfitting). Too long: fit is sluggish and misses fast events. <b>Deconvolved activity should primarily appear during the rise, not spread across the whole decay.</b><br><br>' +
        'The kernel display shows the resulting template \u2014 it should match what a real calcium transient looks like for your indicator. Its peak time and half-decay time are annotated.',
      side: 'right',
    },
    // Step 8: Rise slider
    {
      element: '[data-tutorial="slider-rise"]',
      title: 'Rise Time (tau_rise)',
      description:
        'Controls how quickly calcium rises at event onset. Usually much shorter than decay. Fine-tune after decay is set. Note: <b>changing rise slightly changes optimal decay</b> \u2014 they\u2019re coupled, so re-check decay after adjusting rise.',
      side: 'right',
    },
    // Step 9: Lambda slider
    {
      element: '[data-tutorial="slider-lambda"]',
      title: 'Sparsity Penalty (lambda)',
      description:
        'Controls event count. Start low and increase until noise artifacts disappear from the green trace without losing real events. A value of 1 is a good starting point. The green deconvolved trace should show clean, sharp peaks at real events with a quiet baseline between them. If the reconvolved fit peak starts decreasing away from the raw trace as you increase lambda, your sparsity is too high. <b>Prefer adjusting decay time over relying on high sparsity</b> to control overfitting. Increasing decay can help reduce dense deconvolved activity under big fluorescence events. Most cells will respond well to small sparsity values, but a small percentage of cells may be too noisy for reliable deconvolution \u2014 don\u2019t overfit noisy cells, focus on the average-looking cell.',
      side: 'right',
    },
    // Step 10: Good vs bad fit
    {
      element: '[data-tutorial="card-grid"]',
      title: 'Good Fit vs Bad Fit',
      description:
        '<b>Good:</b> orange tracks blue peaks, green deconvolved activity appears primarily during the rise of calcium events (activity during the decay suggests additional neural activity or an extended response), red looks like noise. <b>Bad:</b> orange misses or undershoots peaks, the orange tail overshoots the raw data, green has activity spread beyond the actual transients, red shows structured patterns.',
      side: 'left',
    },
    // Step 11: Pin for comparison
    {
      element: '[data-tutorial="pin-snapshot"]',
      title: 'Pin for Comparison',
      description:
        'Save the current fit as a dashed overlay, then adjust parameters. The overlay lets you quickly judge whether changes improved the fit.',
      side: 'bottom',
    },
    // Step 12: Completion (centered modal, no element)
    {
      title: 'Basics Complete',
      description:
        'You now understand the cell card layout, traces, and parameter controls. Next, try the \u201CGuided Tuning Workflow\u201D tutorial to learn the recommended step-by-step tuning process.',
    },
  ],
};
