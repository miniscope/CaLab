// CADECON-TUTR-03: Understanding How CaDecon Works.

import type { Tutorial } from '@calab/tutorials';
import { renderKernelShape, renderRelaxToSpikes } from '../theory-figures.ts';

export const theoryTutorial: Tutorial = {
  id: 'theory',
  title: 'Understanding How CaDecon Works',
  description:
    'How CaDecon infers spikes: the calcium model, deconvolution, upsampling, identifying a biologically interpretable kernel, and the alternating loop that ties everything together.',
  level: 'theory',
  prerequisites: [],
  estimatedMinutes: 8,
  recommended: true,
  requiresData: false,
  steps: [
    // Step 1: Introduction
    {
      title: "Understanding CaDecon's Approach",
      description:
        'CaDecon infers both a <b>spike train</b> and the <b>calcium dynamics</b> that produced your fluorescence, while <b>constructing the kernel</b> from the data instead of asking you to set it.<br><br>' +
        'This tutorial walks through how that works, step by step, so you can understand what the algorithm is doing to your data!',
    },
    // Step 2: The problem statement
    {
      title: 'What is CaDecon Actually Solving?',
      description:
        'The absolute simplest question is: <b>which spikes, fired when, would produce the fluorescence trace you actually recorded?</b><br><br>' +
        'CaDecon answers this question by searching for four things at once \u2014 the <b>spikes</b>, the <b>calcium response</b> they generate, a slow <b>baseline</b>, and an overall <b>amplitude</b> that together reconstruct your trace as closely as possible. The goal of CaDecon is to minimize the error between the recording and the reconstruction:<br><br>' +
        '<span class="tutorial-eq">min &#8741; your trace &minus; reconstruction &#8741;<sup>2</sup></span>' +
        'and does so with two constraints: spikes are <b>all-or-nothing</b> events (a neuron either fired or it didn\u2019t), and the corresponding calcium event must follow a realistic <b>rise-and-decay shape</b>. The math behind this is involved and draws on the field of <b>convex optimization</b>, but you don\u2019t need it in depth to understand the core ideas.',
      popoverClass: 'driver-popover--wide',
    },
    // Step 3: The calcium model
    {
      title: 'The Calcium Model',
      description:
        'A spike doesn\u2019t show up as a spike in your trace \u2014 each one adds a slow bump of fluorescence: calcium <b>rises fast</b> after the spike, then <b>decays slowly</b> as it returns toward baseline. CaDecon models that bump with a <b>bi-exponential kernel</b>: one exponential for the fast rise, another for the slow decay.<br><br>' +
        '<span class="tutorial-eq">k(t) = e<sup>&minus;t/\u03C4<sub>d</sub></sup> &minus; e<sup>&minus;t/\u03C4<sub>r</sub></sup></span>' +
        'Two time constants define its shape: the <b>rise constant \u03C4<sub>r</sub></b> (how fast calcium rises) and the <b>decay constant \u03C4<sub>d</sub></b> (how slowly it returns to baseline). The plot shows this shape, annotated with its rise-to-peak time and full-width at half-maximum (FWHM). Convolving the spike train with this kernel gives the expected fluorescence trace. The kernel is scaled to a peak height of 1, so the separate <b>amplitude</b> term carries the real transient size.',
      onPopoverRender: renderKernelShape,
    },
    // Step 4: Explaining FISTA
    {
      title: 'The Hard Part: All-or-Nothing Spikes',
      description:
        'As mentioned, the math underlying CaDecon comes from the field of <b>convex optimization</b>. Requiring spikes to be strictly 0 or 1 makes the problem hard, because there is an enormous number of spike / no-spike combinations to consider.<br><br>' +
        'CaDecon\u2019s trick is to <b>relax the all-or-nothing rule</b>: instead of forcing each spike to be 0 or 1, it lets it take any value in between. This relaxed problem is a convex one that can be solved efficiently with a method called <b>FISTA</b>. The result is a <b>graded spike estimate</b> at each time point \u2014 higher where a spike almost certainly happened, lower where it didn\u2019t. The next step covers how CaDecon returns to the clean spike / no-spike train we ultimately want.',
    },
    // Step 5: Binarization step
    {
      title: 'Getting Back to Real Spikes',
      description:
        'To get back to real spikes, CaDecon picks a <b>cutoff</b>: anything above it counts as a spike, anything below is dropped (the plot shows the graded estimate cut at the cutoff, with the surviving values becoming spikes). But it doesn\u2019t guess the cutoff \u2014 it <b>tries many</b>, and for each one rebuilds the predicted trace and checks how well it matches the recording.<br><br>' +
        'The cutoff whose spikes <b>best reconstruct your data</b> wins. The amplitude is handled differently: at each step it is fit to best match the trace, then re-estimated from one step to the next until it stops changing. The logic throughout is the same: the best answer is the one that explains the trace you actually saw.',
      onPopoverRender: renderRelaxToSpikes,
    },
    // Step 6: Integer spikes via upsampling
    {
      title: 'Upsampling & the Refractory Period',
      description:
        'If your frame rate is low, a neuron can fire several times within a single frame, and a plain spike / no-spike train can only say \u201Csomething happened here,\u201D not \u201Cthree things happened here.\u201D<br><br>' +
        'CaDecon works around this by solving on a <b>finer, upsampled timeline</b>. Each recorded frame is split into <b>k smaller bins</b>, so closely-spaced spikes fall into separate bins. Each bin still only recognizes spikes as 0 or 1, so <b>summing the k bins</b> within a frame gives a whole number from 0 to k: the <b>integer spike count</b> for that frame.<br><br>' +
        'The bin width isn\u2019t arbitrary \u2014 it\u2019s what makes the one-spike-or-none rule <b>biologically valid</b>. By default CaDecon upsamples to <b>300&nbsp;Hz</b>, so each bin spans about <b>3.3&nbsp;ms</b> \u2014 roughly a neuron\u2019s <b>refractory period</b>, the minimum time between two action potentials. A real neuron physically can\u2019t fire twice that fast, so at most one spike belongs in a bin, and binarizing each bin to 0 or 1 mirrors biology. In effect, the bin width sets the <b>minimum inter-spike interval (ISI)</b> CaDecon can resolve.<br><br>' +
        'Without it, forcing binary spikes onto the raw frame grid would distort the count either way: <b>too few</b> spikes when real events are merged into one frame, or <b>too many</b> when spikes are packed closer than a neuron could actually fire. You can change the target under <b>Upsample Target</b> in Algorithm Settings.',
    },
    // Step 7: How fit quality is measured (PVE)
    {
      title: 'Measuring How Well the Fit Explains the Trace',
      description:
        'Every choice CaDecon makes \u2014 the spikes, the cutoff, the amplitude, the kernel \u2014 is judged by a single standard: how closely the <b>reconstruction</b> (spikes convolved with the kernel, plus baseline and amplitude) matches the recording you actually collected. The winning answer is always the one that reconstructs your trace most faithfully.<br><br>' +
        'Overall fit quality is summarized by <b>PVE</b> (proportion of variance explained): the fraction of the trace\u2019s variation the model accounts for. This is the same number you watch climb in the convergence panel.',
    },
    // Step 8: Learning the kernel
    {
      title: 'Learning the Kernel',
      description:
        'Given CaDecon\u2019s current best guess at the spikes, it asks: <b>what overall shape, repeated at those spike times, best reproduces the trace?</b> It first builds that shape <b>directly from the data</b> as a free-form average kernel. After this it fits that kernel to a biexponential function. <br><br>' +
        'When several cells are analyzed together, their traces are <b>pooled</b> so a single <b>shared kernel</b> is learned across them. Because the kernel is a real calcium response, its time constants (\u03C4<sub>r</sub>, \u03C4<sub>d</sub>) carry <b>biological meaning</b>. Thus, a shift in kernel shape across conditions, like different brain regions, could reflect real differences in those neuron\u2019s responses.',
    },
    // Step 9: Two-component biexp fit
    {
      title: 'Separating Real Calcium from Noise',
      description:
        'Each trace\u2019s calcium transient usually contains two things mixed together: the genuine <b>slow calcium transient</b>, and a <b>fast blip</b> from noise or imaging artifacts on top of that signal.<br><br>' +
        'CaDecon fits the shape as the sum of a <b>slow component</b> and a <b>fast component</b>, deliberately preventing the fast one from fitting to anything but putative noise and/or artifacts. It then keeps the <b>slow component</b> as the reported kernel. This is the (\u03C4<sub>r</sub>, \u03C4<sub>d</sub>) that describes your indicator\u2019s true dynamics.',
    },
    // Step 10: The alternating loop
    {
      title: 'CaDecon\u2019s Alternating Loop',
      description:
        'Spikes and kernel depend on each other: you need a kernel to find spikes, but you need spikes to learn the kernel. How does CaDecon deal with this problem?<br><br>' +
        'It starts by guessing where the spikes could be using a rough peak-finding approach. With a rough idea of the spike locations, CaDecon can estimate a <b>first kernel</b>. After that, it alternates between two steps:<br><br>' +
        '<b>1.</b> Use the current kernel to infer spikes.<br>' +
        '<b>2.</b> Use those spikes to re-learn the kernel.<br><br>' +
        'Both parts of the loop improve each other over each iteration until they converge on a consistent answer. To handle large recordings, many <b>subsets</b> of cells and time are solved in parallel and their kernels combined. This back-and-forth is exactly what you see happening in the convergence panel.',
    },
    // Step 11: Stopping + final inference.
    {
      title: 'How does CaDecon know when to stop?',
      description:
        'More iterations aren\u2019t always better. Once the kernel stops changing much from one pass to the next, extra iterations add little \u2014 and the fit can even drift after it has peaked. Rather than watch the raw time constants (which can trade off against each other), CaDecon judges convergence by the kernel\u2019s <b>shape</b> \u2014 its <b>rise-to-peak time</b> and its <b>width (FWHM)</b>. An iteration counts as <b>stable</b> when both change by less than a small tolerance, and CaDecon declares convergence only after <b>several consecutive stable iterations</b>, so one lucky pass can\u2019t stop it early. In practice a good solution usually emerges within just a handful of iterations.<br><br>' +
        'To guard against any late drift, the <b>reported kernel is the consensus</b> (the median shape) of the last few iterations, not whatever the final pass happened to produce. You can make the run stop sooner or keep refining with the <b>Convergence Tolerance</b> setting. There is also a maximum-iteration limit, but that is only a <b>safety cap</b> for a run that never settles \u2014 not how a healthy run should normally end. With a stable kernel in hand, CaDecon runs one <b>final inference across every cell</b>, which is why results appear for all your cells, not just the subsets it learned from.',
    },
    // Step 12: Completion
    {
      title: 'That\u2019s How CaDecon Works',
      description:
        'In summary: CaDecon learns a kernel directly from your data and uses it to infer spikes with minimal to no manual tuning.<br><br>' +
        'To put it into practice, try <b>Your First Automated Deconvolution</b>; to control what the kernel learns from, see <b>Learning What Subsetting Does for CaDecon</b>; and to better understand a finished run, try <b>Reading Convergence &amp; Results</b>.',
    },
  ],
};
