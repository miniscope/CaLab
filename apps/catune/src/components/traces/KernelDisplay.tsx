/**
 * Small chart showing the calcium kernel shape for current tau values.
 * Uses an independent axis (kernel time, not trace time) -- no sync group
 * with the main trace panels.
 */

import { createMemo } from 'solid-js';
import { computeKernel, computeKernelAnnotations } from '@calab/compute';
import { currentTau } from '../../lib/viz-store.ts';
import { samplingRate, isDemo, demoConfig, groundTruthVisible } from '../../lib/data-store.ts';
import { createGroundTruthKernelSeries } from '../../lib/chart/series-config.ts';
import { kernelAnnotationsPlugin, TracePanel } from '@calab/ui/chart';
import type uPlot from 'uplot';

const KERNEL_SYNC_KEY = 'catune-kernel';

export function KernelDisplay() {
  const kernelData = createMemo<[number[], ...(number | null)[][]]>(() => {
    const fs = samplingRate() ?? 30;
    const tau = currentTau();
    const userKernel = computeKernel(tau.tauRise, tau.tauDecay, fs);

    if (groundTruthVisible() && isDemo() && demoConfig()) {
      const cfg = demoConfig()!;
      const trueKernel = computeKernel(cfg.kernel.tau_rise_s, cfg.kernel.tau_decay_s, fs);

      // Align x-axes: use the longer of the two
      const maxLen = Math.max(userKernel.x.length, trueKernel.x.length);
      const x: number[] = new Array(maxLen);
      const yUser: (number | null)[] = new Array(maxLen);
      const yTrue: (number | null)[] = new Array(maxLen);

      const dt = 1 / fs;
      for (let i = 0; i < maxLen; i++) {
        x[i] = i * dt;
        yUser[i] = i < userKernel.y.length ? userKernel.y[i] : null;
        yTrue[i] = i < trueKernel.y.length ? trueKernel.y[i] : null;
      }

      return [x, yUser, yTrue];
    }

    return [userKernel.x, userKernel.y];
  });

  const kernelSeries = createMemo<uPlot.Series[]>(() => {
    const base: uPlot.Series[] = [
      {},
      {
        label: 'Kernel',
        stroke: 'hsl(280, 70%, 60%)',
        width: 1.5,
        fill: 'rgba(160, 100, 220, 0.1)',
      },
    ];

    if (groundTruthVisible() && isDemo() && demoConfig()) {
      base.push(createGroundTruthKernelSeries());
    }

    return base;
  });

  const annotations = createMemo(() => {
    const fs = samplingRate() ?? 30;
    const tau = currentTau();
    return computeKernelAnnotations(tau.tauRise, tau.tauDecay, fs);
  });

  // The getter `() => annotations()` is the tracked scope bridge from
  // Solid into the uPlot plugin API — the plugin invokes it at draw time.
  // eslint-disable-next-line solid/reactivity
  const kernelPlugins: uPlot.Plugin[] = [kernelAnnotationsPlugin(() => annotations(), 1000)];

  return (
    <div class="kernel-section" data-tutorial="kernel-display">
      <h4 class="panel-label">Calcium Kernel</h4>
      <TracePanel
        data={() => kernelData() as [number[], ...number[][]]}
        series={kernelSeries()}
        height={180}
        syncKey={KERNEL_SYNC_KEY}
        xLabel="Time (s)"
        plugins={kernelPlugins}
      />
    </div>
  );
}
