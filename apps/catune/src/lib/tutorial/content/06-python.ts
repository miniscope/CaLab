// TUTR-06: Python Package tutorial.
// Informational tutorial covering the CaLab Python package: installation,
// data loading, interactive tuning bridge, batch deconvolution, and CLI.
// All steps are centered modals (no element) — no data required.
// Pure data definition -- no driver.js imports (TUTR-05 compliance).

import type { Tutorial } from '@calab/tutorials';

export const pythonTutorial: Tutorial = {
  id: 'python',
  title: 'Python Package',
  description:
    'Learn how the CaLab Python package connects to CaTune: installation, data loading, interactive tuning, batch deconvolution, and the CLI.',
  level: 'intermediate',
  prerequisites: [],
  estimatedMinutes: 5,
  requiresData: false,
  steps: [
    // Step 1: Introduction
    {
      title: 'Python Package',
      description:
        'The <code>calab</code> Python package lets you load calcium imaging data, launch CaTune for interactive tuning, run batch deconvolution, and use the command-line interface.<br><br>This tutorial walks through the main features. No data or Python installation is needed to follow along.',
    },
    // Step 2: Installation
    {
      title: 'Installation',
      description:
        'Install from PyPI with pre-built wheels for Windows, macOS, and Linux:' +
        '<pre><code>pip install calab</code></pre>' +
        'To load CaImAn HDF5 or Minian Zarr files, install with optional dependencies:' +
        '<pre><code>pip install calab[loaders]</code></pre>' +
        'This adds <code>h5py</code> and <code>zarr</code> support.',
      popoverClass: 'driver-popover--code',
    },
    // Step 3: Loading Data
    {
      title: 'Loading Data',
      description:
        'Load traces from common calcium imaging pipelines:' +
        '<pre><code>import calab\n\n# CaImAn HDF5\ntraces, meta = calab.load_caiman("results.hdf5")\n\n# Minian Zarr\ntraces, meta = calab.load_minian("minian_output/", fs=30.0)</code></pre>' +
        'Both return a NumPy array <code>(n_cells, n_timepoints)</code> and a metadata dict with <code>sampling_rate_hz</code>, <code>num_cells</code>, and <code>num_timepoints</code>.<br><br>' +
        'You can also use any NumPy array directly \u2014 no special format required.',
      popoverClass: 'driver-popover--code',
    },
    // Step 4: Interactive Tuning
    {
      title: 'Interactive Tuning',
      description:
        '<code>calab.tune()</code> connects Python to CaTune in your browser:' +
        '<pre><code>params = calab.tune(traces, fs=30.0)</code></pre>' +
        'How it works:' +
        '<ol>' +
        '<li>Starts a local HTTP server with your traces</li>' +
        '<li>Opens CaTune with a <code>?bridge=</code> URL parameter</li>' +
        '<li>CaTune loads traces from the bridge server</li>' +
        '<li>When you export parameters, they\u2019re returned to Python</li>' +
        '</ol>' +
        'The returned <code>params</code> dict contains <code>tau_rise</code>, <code>tau_decay</code>, <code>lambda_</code>, <code>fs</code>, and <code>filter_enabled</code>.',
      popoverClass: 'driver-popover--code',
    },
    // Step 5: Saving Tuning Data
    {
      title: 'Saving Tuning Data',
      description:
        'Save traces in CaTune-compatible format for sharing or later use:' +
        '<pre><code>calab.save_for_tuning(traces, fs=30.0, path="my_recording")\n# Creates: my_recording.npy + my_recording_metadata.json</code></pre>' +
        'The <code>.npy</code> file can be opened directly in CaTune via the file picker, and the JSON sidecar stores the sampling rate and dimensions.',
      popoverClass: 'driver-popover--code',
    },
    // Step 6: Batch Deconvolution
    {
      title: 'Batch Deconvolution',
      description:
        'Run FISTA deconvolution on one or more traces:' +
        '<pre><code># Activity only\nactivity = calab.run_deconvolution(\n    traces, fs=30.0,\n    tau_r=0.02, tau_d=0.2, lam=0.05\n)\n\n# Full result\nresult = calab.run_deconvolution_full(\n    traces, fs=30.0,\n    tau_r=0.02, tau_d=0.2, lam=0.05\n)</code></pre>' +
        'The full result includes <code>activity</code>, <code>baseline</code>, <code>reconvolution</code>, <code>iterations</code>, and <code>converged</code>.',
      popoverClass: 'driver-popover--code',
    },
    // Step 7: Using Exported Parameters
    {
      title: 'Using Exported Parameters',
      description:
        'The recommended workflow is: tune interactively, export a JSON, then apply to all your data:' +
        '<pre><code># Apply exported parameters to traces\nactivity = calab.deconvolve_from_export(\n    traces, "catune_export.json"\n)\n\n# With full results (baseline, reconvolution, etc.)\nresult = calab.deconvolve_from_export(\n    traces, "catune_export.json", return_full=True\n)</code></pre>' +
        'This loads the parameters from the CaTune export JSON and applies any bandpass filter settings automatically.',
      popoverClass: 'driver-popover--code',
    },
    // Step 8: Command-Line Interface
    {
      title: 'Command-Line Interface',
      description:
        'CaLab provides a <code>calab</code> CLI with four commands:' +
        '<pre><code># Interactive tuning\ncalab tune recording.npy --fs 30.0\n\n# Batch deconvolution\ncalab deconvolve traces.npy --params export.json -o activity.npy\n\n# Convert CaImAn/Minian to CaLab format\ncalab convert results.hdf5 --format caiman --fs 30.0\n\n# Show file info\ncalab info recording.npy</code></pre>',
      popoverClass: 'driver-popover--code',
    },
    // Step 9: Complete Workflow
    {
      title: 'Complete Workflow',
      description:
        'Here\u2019s a typical end-to-end workflow:' +
        '<pre><code>import calab\n\n# 1. Load data\ntraces, meta = calab.load_caiman("results.hdf5")\nfs = meta["sampling_rate_hz"]\n\n# 2. Tune interactively\nparams = calab.tune(traces, fs=fs)\n\n# 3. Deconvolve all traces\nresult = calab.run_deconvolution_full(\n    traces, fs=fs,\n    tau_r=params["tau_rise"],\n    tau_d=params["tau_decay"],\n    lam=params["lambda_"]\n)</code></pre>',
      popoverClass: 'driver-popover--code',
    },
    // Step 10: Completion
    {
      title: 'Tutorial Complete',
      description:
        'Key takeaways:' +
        '<ul>' +
        '<li><code>pip install calab</code> \u2014 pre-built wheels, no compilation needed</li>' +
        '<li><code>calab.tune()</code> \u2014 bridges Python data to CaTune in the browser</li>' +
        '<li><code>calab.deconvolve_from_export()</code> \u2014 applies tuned parameters to all data</li>' +
        '<li><code>calab</code> CLI \u2014 tune, deconvolve, convert, and inspect from the terminal</li>' +
        '</ul>' +
        'For full API documentation, see the <a href="https://github.com/miniscope/CaLab/blob/main/python/README.md" target="_blank" rel="noopener">Python README</a>.',
    },
  ],
};
