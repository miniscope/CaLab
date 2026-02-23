// TUTR-04: Features & Community tutorial.
// Standalone tutorial covering navigation, analysis tools, and community features.
// No prerequisites — users can explore these features anytime after loading data.
// Pure data definition -- no driver.js imports (TUTR-05 compliance).

import type { Tutorial } from '@calab/tutorials';

export const featuresTutorial: Tutorial = {
  id: 'features',
  title: 'Features & Community',
  description:
    'Explore CaTune\u2019s navigation, analysis tools, and community features. No parameter tuning knowledge required.',
  level: 'beginner',
  prerequisites: [],
  estimatedMinutes: 3,
  steps: [
    // Step 1: Welcome (centered modal, no element)
    {
      title: 'Explore CaTune Features',
      description:
        'This tour covers CaTune\u2019s navigation, analysis tools, and community features. No parameter tuning knowledge required.',
    },
    // Step 2: Header bar
    {
      element: '[data-tutorial="header-bar"]',
      title: 'The Header Bar',
      description:
        'Your dataset info is displayed here: filename, cell count, timepoints, sampling rate, and duration. Action buttons on the right let you access tutorials, the sidebar, feedback, and switch datasets.',
      side: 'bottom',
    },
    // Step 3: Feedback menu
    {
      element: '[data-tutorial="feedback-menu"]',
      title: 'Share Feedback',
      description:
        'Click <b>Feedback</b> to report bugs, request features, or share suggestions. Each option opens a pre-filled GitHub issue \u2014 no account setup needed beyond GitHub.',
      side: 'bottom',
    },
    // Step 4: Cell Selection & Grid (merged: cell selector + grid columns)
    {
      element: '[data-tutorial="cell-selector"]',
      title: 'Cell Selection & Grid',
      description:
        'Choose which cells to display: <b>Top Active</b> (ranked by activity), <b>Random</b>, or <b>Manual</b> (type specific cell numbers). Adjust the count to your preference. Use +/\u2212 to set grid columns and drag the resize handle to change card height.',
      side: 'top',
    },
    // Step 5: Trace Legend
    {
      element: '[data-tutorial="legend-bar"]',
      title: 'Trace Legend',
      description:
        '<b>Click any legend item</b> to show or hide that trace type. The \u201C?\u201D button explains what each trace represents.',
      side: 'bottom',
    },
    // Step 6: Spectrum Analysis (merged: sidebar toggle + select spectrum tab + spectrum panel)
    {
      element: '[data-tutorial="sidebar-toggle"]',
      title: 'Spectrum Analysis',
      description:
        'Open the <b>Sidebar</b> and select the <b>Spectrum tab</b>. The power spectral density shows frequency content for the selected cell (blue) and all cells (gray). With Noise Filter on, dashed lines show the bandpass cutoffs.',
      side: 'bottom',
      popoverClass: 'driver-popover--wide',
    },
    // Step 7: Fit Quality Metrics (merged: select metrics tab + metrics panel)
    {
      element: '[data-tutorial="sidebar-tab-metrics"]',
      title: 'Fit Quality Metrics',
      description:
        'Select the <b>Metrics tab</b> to see per-cell SNR, R\u00B2, and sparsity. Use this to identify cells with poor fits and assess overall parameter quality.',
      side: 'bottom',
    },
    // Step 8: Community Parameters (merged: select community tab + community browser)
    {
      element: '[data-tutorial="sidebar-tab-community"]',
      title: 'Community Parameters',
      description:
        'Select the <b>Community tab</b> to browse shared parameters. The scatter plot shows tau_rise vs tau_decay, colored by lambda. Use filters to narrow by indicator, species, or brain region. Toggle \u201CCompare my params\u201D to overlay your current values.',
      side: 'bottom',
      popoverClass: 'driver-popover--wide',
    },
    // Step 9: Share Parameters
    {
      element: '[data-tutorial="export-panel"]',
      title: 'Share Your Parameters',
      description:
        'When your parameters produce good fits, export them locally as JSON or submit to the community database. Community submissions help others find good starting points for similar experiments.',
      side: 'top',
    },
    // Step 10: Completion (centered modal, no element)
    {
      title: 'Tour Complete',
      description:
        'You\u2019ve explored CaTune\u2019s features! For parameter tuning guidance, try the <b>Understanding Parameters</b> tutorial.',
    },
  ],
};
