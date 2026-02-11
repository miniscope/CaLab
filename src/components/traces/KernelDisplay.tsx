/**
 * Small chart showing the calcium kernel shape for current tau values.
 * Uses an independent axis (kernel time, not trace time) -- no sync group
 * with the main trace panels.
 */

import { createMemo } from 'solid-js';
import { computeKernel } from '../../lib/chart/kernel-math';
import { tauRise, tauDecay } from '../../lib/viz-store';
import { samplingRate } from '../../lib/data-store';
import { TracePanel } from './TracePanel';
import type uPlot from 'uplot';

const KERNEL_SYNC_KEY = 'catune-kernel';

export function KernelDisplay() {
  // Recompute kernel whenever tau values or sampling rate change
  const kernelData = createMemo<[number[], ...number[][]]>(() => {
    const fs = samplingRate() ?? 30;
    const kernel = computeKernel(tauRise(), tauDecay(), fs);
    return [kernel.x, kernel.y];
  });

  const kernelSeries: uPlot.Series[] = [
    {}, // x-axis placeholder
    {
      label: 'Kernel',
      stroke: 'hsl(280, 70%, 60%)',
      width: 1.5,
      fill: 'rgba(160, 100, 220, 0.1)',
    },
  ];

  return (
    <div class="kernel-section">
      <div class="kernel-section__header">
        <h4 class="panel-label">Calcium Kernel</h4>
        <p class="kernel-section__params">
          tau_rise = {tauRise().toFixed(3)}s, tau_decay = {tauDecay().toFixed(2)}s
        </p>
      </div>
      <TracePanel
        data={() => kernelData()}
        series={kernelSeries}
        height={100}
        syncKey={KERNEL_SYNC_KEY}
      />
    </div>
  );
}
