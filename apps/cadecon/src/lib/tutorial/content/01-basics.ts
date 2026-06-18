// CADECON-TUTR-01: Your First Automated Deconvolution.

import type { Tutorial } from '@calab/tutorials';

export const basicsTutorial: Tutorial = {
  id: 'basics',
  title: 'Your First Automated Deconvolution',
  description:
    'Let\u2019s walk through the entirety of CaDecon together for the first time! Learn how to: load data, understand the dashboard, start an automated run, and read the results. No tuning required! CaDecon constructs the kernel for you.',
  level: 'beginner',
  prerequisites: [],
  estimatedMinutes: 5,
  steps: [
    // Step 1: Welcome
    {
      title: 'Welcome to CaDecon :)',
      description:
        'CaDecon performs <b>automated</b> calcium deconvolution. Unlike manual tuned approaches, you don\u2019t set most parameters by hand. Instead, CaDecon <b>constructs a shared kernel from your data</b> and refines it over several iterations.<br><br>' +
        'Together we will walk through one complete run where we will set the deconvolution parameter configuration, start a run, and interpret the results we get. If you don\u2019t have data loaded, use the demo dataset from the import screen to follow along.',
    },
    // Step 2: Header bar
    {
      element: '[data-tutorial="header-bar"]',
      title: 'The Dashboard',
      description:
        'The header shows your dataset: filename, cell count, timepoints, sampling rate, and duration. The worker indicator (light grey "w" with a number)shows how many parallel workers are available. CaDecon deconvolves many traces at once and the number of workers is automatically optimized by available memory. Action buttons on the right open tutorials, the community sidebar, feedback, and even lets you switch datasets.',
      side: 'bottom',
    },
    // Step 3: The control sidebar overview
    {
      element: '[data-tutorial="subset-config"]',
      title: 'The Control Sidebar',
      description:
        'The left sidebar holds everything you configure <b>before</b> a run. From top to bottom: <b>Subset Configuration</b>, <b>Algorithm Settings</b>, and <b>Run Controls</b>. The defaults are generally good for most datasets but you can adjust them as needed. To understand how, check the rest of the tutorials. For your first run you can leave them all as they are and just press Start.<br><br>' +
        'Subsets are the slices of your data CaDecon learns the kernel from. The dedicated \u201CLearning What Subsetting Does for CaDecon\u201D tutorial covers them in depth; for now, the defaults are fine.',
      side: 'right',
      popoverClass: 'driver-popover--wide',
    },
    // Step 4: Algorithm settings
    {
      element: '[data-tutorial="algorithm-settings"]',
      title: 'Algorithm Settings',
      description:
        'These control <b>how</b> the algorithm runs: the upsample target, the maximum number of iterations, the convergence tolerance, and optional high-pass / low-pass filters applied before deconvolution. Defaults should work for data. Leave them for now but if you want to learn more, go to the \u201CLearning What Subsetting Does for CaDecon\u201D and the \u201CReading Convergence & Results\u201D tutorials explain when and how to change them.',
      side: 'right',
    },
    // Step 5: Start the run
    {
      element: '[data-tutorial="run-controls"]',
      title: 'Start the Run',
      description:
        'Press <b>Start</b> to begin. CaDecon assigns traces across the worker pool and iterates. It constructs a kernel from the subsets, deconvolves the data, then refines both the kernel and inferred activity. You can <b>Pause</b>, <b>Stop</b>, or <b>Reset</b> at any time. The progress bar below tracks completion. <b>Press Start now and see how it runs!!</b>',
      side: 'right',
      disableActiveInteraction: false,
    },
    // Step 6: Raster overview
    {
      element: '[data-tutorial="raster"]',
      title: 'The Raster & Subset Placement',
      description:
        'This is your data as a cells \u00D7 time image ( Brighter means higher activity). The outlined rectangles are the <b>subsets</b> CaDecon constructs the kernel from. Click a rectangle to select that subset; its constructed kernel and stats appear in the other panels.',
      side: 'bottom',
    },
    // Step 7: Convergence panel
    {
      element: '[data-tutorial="kernel-convergence"]',
      title: 'Watching It Converge',
      description:
        'As the run increases in iterations, these tabbed charts track the learning process: <b>Kernel</b> shape over iterations, plus <b>Alpha</b>, <b>Threshold</b>, <b>PVE</b>, <b>Event Rate</b>, and <b>Spike Eff.</b> trends. A good run shows these settling toward stable values. Don\u2019t judge a fit until the run has converged.',
      side: 'bottom',
      popoverClass: 'driver-popover--wide',
    },
    // Step 8: Kernel display
    {
      element: '[data-tutorial="kernel-display"]',
      title: 'The Constructed Kernel',
      description:
        'This is the calcium kernel CaDecon <b>constructed from your data</b>. The thin colored curves are per-subset estimates of the free-kernel (See theory tutorial for more info). The <b>bold curve</b> is the fitted two-component model, annotated with the rise time to Peak and Full-width at Half Maximum (FWHM). A good calcium-shaped curve is one with a fast rise and slow, exponential-like decay. This indicates the subsets contained good events to learn from.',
      side: 'left',
    },
    // Step 9: Trace inspector
    {
      element: '[data-tutorial="trace-viewer"]',
      title: 'Inspecting a Trace',
      description:
        'The Trace Inspector overlays, for the selected cell: <b>raw</b> fluorescence, the optional <b>filtered</b> trace, the model <b>fit</b>, the <b>deconvolved</b> activity, and the <b>residual</b>. Toggle any band in the legend. When the run is good, the fit tracks the raw peaks and residuals look like noise. Use the minimap to pan and Ctrl+Scroll to zoom, just like in CaTune.',
      side: 'top',
      popoverClass: 'driver-popover--wide',
    },
    // Step 10: Completion
    {
      title: 'First Run Complete!',
      description:
        'Huzzah!! You made it through the full loop! Take time to look at each of the panels after your results are shown. Next, try <b>Learning What Subsetting Does for CaDecon</b> to learn more about how subsets influence kernel construction, or <b>Understanding InDeCa, the algorithm underlying CaDecon</b> for the theory behind CaDecon. Best of luck with your analysis!',
    },
  ],
};