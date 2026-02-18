/**
 * Small chart showing the calcium kernel shape for current tau values.
 * Uses an independent axis (kernel time, not trace time) -- no sync group
 * with the main trace panels.
 */

import { createMemo } from 'solid-js';
import { computeKernel, computeKernelAnnotations } from '../../lib/chart/kernel-math.ts';
import { kernelAnnotationsPlugin } from '../../lib/chart/kernel-annotations-plugin.ts';
import { tauRise, tauDecay } from '../../lib/viz-store.ts';
import { samplingRate, isDemo, demoPreset, groundTruthVisible } from '../../lib/data-store.ts';
import { createGroundTruthKernelSeries } from '../../lib/chart/series-config.ts';
import { TracePanel } from './TracePanel.tsx';
import type uPlot from 'uplot';

const KERNEL_SYNC_KEY = 'catune-kernel';

export function KernelDisplay() {
  const kernelData = createMemo<[number[], ...((number | null)[])[]]>(() => {
    const fs = samplingRate() ?? 30;
    const userKernel = computeKernel(tauRise(), tauDecay(), fs);

    if (groundTruthVisible() && isDemo() && demoPreset()) {
      const preset = demoPreset()!;
      const trueKernel = computeKernel(preset.params.tauRise, preset.params.tauDecay, fs);

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

    if (groundTruthVisible() && isDemo() && demoPreset()) {
      base.push(createGroundTruthKernelSeries());
    }

    return base;
  });

  const annotations = createMemo(() => {
    const fs = samplingRate() ?? 30;
    return computeKernelAnnotations(tauRise(), tauDecay(), fs);
  });

  const kernelPlugins = createMemo<uPlot.Plugin[]>(() => [
    kernelAnnotationsPlugin(() => annotations()),
  ]);

  return (
    <div class="kernel-section" data-tutorial="kernel-display">
      <h4 class="panel-label">Calcium Kernel</h4>
      <TracePanel
        data={() => kernelData() as [number[], ...number[][]]}
        series={kernelSeries()}
        height={180}
        syncKey={KERNEL_SYNC_KEY}
        xLabel="Time (s)"
        plugins={kernelPlugins()}
      />
    </div>
  );
}
