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
  estimatedMinutes: 4,
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
    // Step 4: Cell selector
    {
      element: '[data-tutorial="cell-selector"]',
      title: 'Cell Selection Controls',
      description:
        'Choose which cells to display: <b>Top Active</b> (ranked by activity), <b>Random</b>, or <b>Manual</b> (type specific cell numbers). Adjust the count and grid columns to your preference.',
      side: 'top',
    },
    // Step 5: Grid columns
    {
      element: '[data-tutorial="grid-columns"]',
      title: 'Customize the Grid',
      description:
        'Use +/\u2212 to set 1\u20136 columns. Fewer columns = larger cards. Drag the resize handle at the bottom of any card to adjust height.',
      side: 'bottom',
    },
    // Step 6: Legend bar
    {
      element: '[data-tutorial="legend-bar"]',
      title: 'Trace Legend',
      description:
        '<b>Click any legend item</b> to show or hide that trace type. The \u201C?\u201D button explains what each trace represents.',
      side: 'bottom',
    },
    // Step 7: Sidebar toggle
    {
      element: '[data-tutorial="sidebar-toggle"]',
      title: 'The Sidebar',
      description:
        'Click <b>Sidebar</b> to open the analysis panel. It has tabs for Spectrum, Metrics, and Community (when available).',
      side: 'bottom',
    },
    // Step 8: Select Spectrum tab
    {
      element: '[data-tutorial="sidebar-tab-spectrum"]',
      title: 'Select the Spectrum Tab',
      description:
        'The sidebar defaults to the Community tab. <b>Click the Spectrum tab</b> to see frequency analysis.',
      side: 'bottom',
    },
    // Step 9: Spectrum panel
    {
      element: '[data-tutorial="spectrum-panel"]',
      title: 'Spectrum Analysis',
      description:
        'The Spectrum tab shows power spectral density for the selected cell (blue) and all cells (gray). When Noise Filter is on, dashed lines show the bandpass cutoffs.',
      side: 'left',
    },
    // Step 10: Select Metrics tab
    {
      element: '[data-tutorial="sidebar-tab-metrics"]',
      title: 'Select the Metrics Tab',
      description: '<b>Click the Metrics tab</b> to see quantitative fit quality.',
      side: 'bottom',
    },
    // Step 11: Metrics panel
    {
      element: '[data-tutorial="metrics-panel"]',
      title: 'Fit Quality Metrics',
      description:
        'The Metrics tab shows per-cell SNR, R\u00B2, and sparsity. Use this to identify cells with poor fits and assess overall parameter quality.',
      side: 'left',
    },
    // Step 12: Select Community tab
    {
      element: '[data-tutorial="sidebar-tab-community"]',
      title: 'Select the Community Tab',
      description: '<b>Click the Community tab</b> to browse shared parameters.',
      side: 'bottom',
    },
    // Step 13: Community browser
    {
      element: '[data-tutorial="community-browser"]',
      title: 'Community Parameters',
      description:
        'Browse parameters shared by other researchers. The scatter plot shows tau_rise vs tau_decay, colored by lambda. Use filters to narrow by indicator, species, or brain region. Toggle \u201CCompare my params\u201D to overlay your current values.',
      side: 'left',
    },
    // Step 11: Export panel
    {
      element: '[data-tutorial="export-panel"]',
      title: 'Share Your Parameters',
      description:
        'When your parameters produce good fits, export them locally as JSON or submit to the community database. Community submissions help others find good starting points for similar experiments.',
      side: 'top',
    },
    // Step 12: Completion (centered modal, no element)
    {
      title: 'Tour Complete',
      description:
        'You\u2019ve explored CaTune\u2019s features! For parameter tuning guidance, try the <b>Understanding Parameters</b> tutorial.',
    },
  ],
};
