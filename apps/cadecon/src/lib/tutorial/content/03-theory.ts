// CADECON-TUTR-03: Understanding InDeCa, the algorithm underlying CaDecon.

import type { Tutorial } from '@calab/tutorials';

export const theoryTutorial: Tutorial = {
  id: 'theory',
  title: 'Understanding InDeCa, the algorithm underlying CaDecon',
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
      title: "Understanding InDeCa's Approach",
      description:
        'CaDecon implements <b>InDeCa</b>: it infers both a <b>spike train</b> and the <b>calcium dynamics</b> that produced your fluorescence, while <b>constructing the kernel</b> from the data instead of asking you to set it.<br><br>' +
        'This tutorial walks through how that works, step by step, so you can understand what the algorithm is doing to your data!',
    },
    // Step 2: The problem statement
    {
      title: 'What is InDeCa Actually Solving?',
      description:
        'The absolute simplest question is: <b>which spikes, fired when, would produce the fluorescence trace you actually recorded?</b><br><br>' +
        'InDeCa answers this question by searching for four things at once \u2014 the <b>spikes</b>, the <b>calcium response</b> they generate, a slow <b>baseline</b>, and an overall <b>amplitude</b> that together reconstruct your trace as closely as possible. The goal of InDeCa is to minimize the error between the recording and the reconstruction:<br><br>' +
        '<b>min \u2016 your trace \u2212 reconstruction \u2016\u00B2</b><br><br>' +
        'and does so with two constraints: spikes are <b>all-or-nothing</b> events (a neuron either fired or it didn\u2019t), and the corresponding calcium event must follow a realistic <b>rise-and-decay shape</b>. The math behind this is involved and draws on the field of <b>convex optimization</b>, but you don\u2019t need it in depth to understand the core ideas.',
    },
    // Step 3: The calcium model
    {
      title: 'The Calcium Model',
      description:
        'A spike doesn\u2019t show up as a spike in your trace \u2014 each one adds a slow bump of fluorescence: calcium <b>rises fast</b> after the spike, then <b>decays slowly</b> as it returns toward baseline. InDeCa models that bump with a <b>bi-exponential kernel</b>: one exponential for the fast rise, another for the slow decay.<br><br>' +
        '<b>kernel = (slow decay) \u2212 (fast rise)</b><br><br>' +
        'Two time constants define its shape: the <b>rise constant \u03C4_r</b> (how fast calcium rises) and the <b>decay constant \u03C4_d</b> (how slowly it returns to baseline). Convolving the spike train with this kernel gives the expected fluorescence trace. The kernel is scaled to a peak height of 1, so the separate <b>amplitude</b> term carries the real transient size.',
    },
    // Step 4: Explaining FISTA
    {
      title: 'The Hard Part: All-or-Nothing Spikes',
      description:
        'As mentioned, the math underlying InDeCa comes from the field of <b>convex optimization</b>. Requiring spikes to be strictly 0 or 1 makes the problem hard, because there is an enormous number of spike / no-spike combinations to consider.<br><br>' +
        'InDeCa\u2019s trick is to <b>relax the all-or-nothing rule</b>: instead of forcing each spike to be 0 or 1, it lets it take any value in between. This relaxed problem is a convex one that can be solved efficiently with a method called <b>FISTA</b>. The result is a <b>graded spike estimate</b> at each time point \u2014 higher where a spike almost certainly happened, lower where it didn\u2019t. The next step covers how InDeCa returns to the clean spike / no-spike train we ultimately want.',
    },
    // Step 5: Binarization step
    {
      title: 'Getting Back to Real Spikes',
      description:
        'To get back to real spikes, InDeCa picks a <b>cutoff</b>: anything above it counts as a spike, anything below is dropped. But it doesn\u2019t guess the cutoff, it <b>tries many</b> and for each one rebuilds the predicted trace and checks how well it matches the recording.<br><br>' +
        'The cutoff whose spikes <b>best reconstruct your data</b> wins. The amplitude is handled differently: at each step it is fit to best match the trace, then re-estimated from one step to the next until it stops changing. The logic throughout is the same: the BEST answer is the one that explains the trace you actually saw.',
    },
    // Step 6: Integer spikes via upsampling
    {
      title: 'Allowing More Than One Spike per Frame',
      description:
        'If your frame rate is low, a neuron can fire several times within a single frame, and a plain spike / no-spike train can only say \u201Csomething happened here,\u201D not \u201Cthree things happened here.\u201D<br><br>' +
        'InDeCa works around this by solving on a <b>finer, upsampled timeline</b>. Each recorded frame is split into <b>k smaller bins</b>, so closely-spaced spikes fall into separate bins. Each bin still only recognizes spikes as 0 or 1, so <b>summing the k bins</b> within a frame gives a whole number from 0 to k: the <b>integer spike count</b> for that frame.',
    },
    // Step 7: How fit quality is measured (PVE)
    {
      title: 'Measuring How Well the Fit Explains the Trace',
      description:
        'Every choice InDeCa makes \u2014 the spikes, the cutoff, the amplitude, the kernel \u2014 is judged by a single standard: how closely the <b>reconstruction</b> (spikes convolved with the kernel, plus baseline and amplitude) matches the recording you actually collected. The winning answer is always the one that reconstructs your trace most faithfully.<br><br>' +
        'Overall fit quality is summarized by <b>PVE</b> (proportion of variance explained): the fraction of the trace\u2019s variation the model accounts for. This is the same number you watch climb in the convergence panel.',
    },
    // Step 8: Learning the kernel
    {
      title: 'Learning the Kernel',
      description:
        'Given InDeCa\u2019s current best guess at the spikes, it asks: <b>what overall shape, repeated at those spike times, best reproduces the trace?</b> It first builds that shape <b>directly from the data</b> as a free-form average kernel. After this it fits that kernel to a biexponential function. <br><br>' +
        'When several cells are analyzed together, their traces are <b>pooled</b> so a single <b>shared kernel</b> is learned across them. Because the kernel is a real calcium response, its time constants (\u03C4_r, \u03C4_d) carry <b>biological meaning</b>. Thus, a shift in kernel shape across conditions, like different brain regions, could reflect real differences in those neuron\u2019s responses.',
    },
    // Step 9: Two-component biexp fit
    {
      title: 'Separating Real Calcium from Noise',
      description:
        'Each trace\u2019s calcium transient usually contains two things mixed together: the genuine <b>slow calcium transient</b>, and a <b>fast blip</b> from noise or imaging artifacts on top of that signal.<br><br>' +
        'InDeCa fits the shape as the sum of a <b>slow component</b> and a <b>fast component</b>, deliberately preventing the fast one from fitting to anything but putative noise and/or artifacts. It then keeps the <b>slow component</b> as the reported kernel. This is the (\u03C4_r, \u03C4_d) that describes your indicator\u2019s true dynamics.',
    },
    // Step 10: The alternating loop
    {
      title: 'InDeCa\u2019s Alternating Loop',
      description:
        'Spikes and kernel depend on each other: you need a kernel to find spikes, but you need spikes to learn the kernel. How does InDeCa deal with this problem?<br><br>' +
        'It starts by guessing where the spikes could be using a rough peak-finding approach. With a rough idea of the spike locations, InDeCa can estimate a <b>first kernel</b>. After that, it alternates between two steps:<br><br>' +
        '<b>1.</b> Use the current kernel to infer spikes.<br>' +
        '<b>2.</b> Use those spikes to re-learn the kernel.<br><br>' +
        'Both parts of the loop improve each other over each iteration until they converge on a consistent answer. To handle large recordings, many <b>subsets</b> of cells and time are solved in parallel and their kernels combined. This back-and-forth is exactly what you see happening in the convergence panel.',
    },
    // Step 11: Stopping + final inference.
    // NOTE: The exact stop criterion \u2014 and whether the reported kernel comes from
    // the stopping iteration or a potentially better earlier iteration \u2014 is still
    // being finalized (see iteration-manager.ts: best-residual tracking + the
    // currently-disabled patience early-stop). Keep this description general until
    // the approach is locked in, then tighten the wording here.
    {
      title: 'How does InDeCa know when to stop?',
      description:
        'More iterations aren\u2019t always better. Once the kernel and spikes stop changing much from one pass to the next, extra iterations add little \u2014 and the fit can even drift after it has peaked. InDeCa watches how much the kernel changes between iterations and <b>settles once it stabilizes</b>. In practice a good solution usually emerges within just a handful of iterations.<br><br>' +
        'There is also a maximum-iteration limit, but that is only a <b>safety cap</b> to stop a run that never settles \u2014 it is not how a healthy run should normally end. With a stable kernel in hand, InDeCa runs one <b>final inference across every cell</b>, which is why results appear for all your cells, not just the subsets it learned from.',
    },
    // Step 12: Completion
    {
      title: 'That\u2019s InDeCa!',
      description:
        'In summary: InDeCa learns a kernel directly from your data and uses it to infer spikes with minimal to no manual tuning.<br><br>' +
        'To put it into practice, try <b>Your First Automated Deconvolution</b>; to control what the kernel learns from, see <b>Learning What Subsetting Does for CaDecon</b>; and to better understand a finished run, try <b>Reading Convergence &amp; Results</b>.',
    },
  ],
};
