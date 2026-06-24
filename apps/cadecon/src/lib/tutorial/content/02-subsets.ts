// CADECON-TUTR-02: Learning What Subsetting Does for CaDecon.

import type { Tutorial } from '@calab/tutorials';

export const subsetsTutorial: Tutorial = {
  id: 'subsets',
  title: 'Learning What Subsetting Does for CaDecon',
  description:
    'CaDecon learns its kernel from subsets which are just rectangular slices of your cells \u00D7 time data. In this tutorial, you will learn how the number of subsets, coverage, and aspect ratio shape what the kernel learns from.',
  level: 'intermediate',
  prerequisites: ['basics'],
  estimatedMinutes: 5,
  steps: [
    // Step 1: Introduction
    {
      title: 'Why Subsets?',
      description:
        'CaDecon learns a <b>single shared kernel</b> for your recording, but it doesn\u2019t need every cell and every timepoint to do so. Using all of the data would be slow and redundant, and the cost grows quickly as datasets get larger. Instead, it learns from <b>subsets</b>: rectangular regions of the cells \u00D7 time raster. Choosing these well gives a clean kernel quickly; choosing them poorly can give a noisy or unrepresentative kernel.',
    },
    // Step 2: See the subsets on the raster
    {
      element: '[data-tutorial="raster"]',
      title: 'Subsets on the Raster',
      description:
        'Each outlined rectangle is one subset. CaDecon <b>auto-places</b> them across the raster. As a consequence, you don\u2019t drag them manually. Together they sample a representative spread of cells and time. Click any rectangle to select it and see its learned kernel in the Kernel Shape panel.',
      side: 'bottom',
    },
    // Step 3: Number of subsets (K)
    {
      element: '[data-tutorial="subset-config"]',
      title: 'Subsets (K)',
      description:
        'The first slider sets <b>K</b>, the number of subsets. More subsets sample more of your data and average out cell-to-cell variation but requires more computing time and resources. The panel warns when <b>K exceeds the maximum non-overlapping count</b>. Beyond that, subsets start to overlap, which can oversample some regions. Try a few values and watch the rectangles re-place.',
      side: 'right',
      disableActiveInteraction: false,
    },
    // Step 4: Total coverage
    {
      element: '[data-tutorial="subset-config"]',
      title: 'Total Coverage',
      description:
        'Coverage is the fraction of the full raster the subsets span, shown live as <b>% cells, % time, % total</b> below the sliders. Higher coverage means more data informs the kernel (more robust but slower). Lower coverage is faster but risks missing the cells with the cleanest events. For most data, the default is a good balance but you can adjust it based on your specific needs.',
      side: 'right',
    },
    // Step 5: Aspect ratio
    {
      element: '[data-tutorial="subset-config"]',
      title: 'Subset Aspect Ratio',
      description:
        'Aspect ratio trades <b>cells against time</b> within each subset. A wide subset spans more timepoints of fewer cells (good when events are sparse in time); a tall subset spans more cells over a shorter window (good when many cells are active simultaneously). The kernel is learned from whatever events fall inside, so shape the subsets toward where your clean transients live.',
      side: 'right',
    },
    // Step 6: Re-tile with the dice
    {
      element: '[data-tutorial="subset-config"]',
      title: 'Re-tiling the Subsets',
      description:
        'The dice button by the <b>Subset Configuration</b> label randomizes subset placement with a new seed, keeping K, coverage, and aspect ratio fixed. Use it to check that your kernel is <b>stable across different placements</b>. If the learned kernel shifts a lot when you re-tile, the recording may be heterogeneous and you likely want higher K or coverage to take this into account.',
      side: 'right',
    },
    // Step 7: Judge the effect on the kernel
    {
      element: '[data-tutorial="kernel-display"]',
      title: 'Judging the Effect',
      description:
        'After a run, check the inferred kernel here. The per-subset curves (thin lines) should <b>agree closely</b>. If you have tight clustering of these thin lines, it means your subsets are sampling a consistent kernel. Wide scatter between subsets signals that different parts of the recording have different kinetics, or that some subsets caught mostly noise. Adjust K, coverage, or aspect ratio and re-run the deconvolution to tighten it.',
      side: 'left',
    },
    // Step 8: Completion
    {
      title: 'That\u2019s Subset Strategy',
      description:
        'You should now understand how the subset parameters shape what the kernel is constructed from:<br>' +
        '<ul>' +
        '<li><b>K</b> and <b>coverage</b> set how much data informs the kernel.</li>' +
        '<li><b>Aspect ratio</b> shapes where it samples.</li>' +
        '<li><b>Re-tiling</b> tests stability.</li>' +
        '</ul>' +
        'For the theory behind how a shared kernel is constructed, see <b>Understanding How CaDecon Works</b>.',
    },
  ],
};
