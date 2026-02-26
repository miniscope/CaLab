/**
 * Small chart showing a single subset's h_free vs the merged bi-exp fit.
 */

import { createMemo, type JSX } from 'solid-js';
import { SolidUplot } from '@dschz/solid-uplot';
import type uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import '../../lib/chart/chart-theme.css';
import type { KernelSnapshot, SubsetKernelSnapshot } from '../../lib/iteration-store.ts';

const AXIS_TEXT = '#616161';
const AXIS_GRID = 'rgba(0, 0, 0, 0.06)';
const AXIS_TICK = 'rgba(0, 0, 0, 0.15)';

const D3_CATEGORY10 = [
  '#1f77b4',
  '#ff7f0e',
  '#2ca02c',
  '#d62728',
  '#9467bd',
  '#8c564b',
  '#e377c2',
  '#7f7f7f',
  '#bcbd22',
  '#17becf',
];

export interface SubsetKernelFitProps {
  subsetIdx: number;
  snapshot: KernelSnapshot;
}

export function SubsetKernelFit(props: SubsetKernelFitProps): JSX.Element {
  const subsetData = createMemo((): SubsetKernelSnapshot | null => {
    const snap = props.snapshot;
    if (props.subsetIdx >= snap.subsets.length) return null;
    return snap.subsets[props.subsetIdx];
  });

  const chartData = createMemo((): uPlot.AlignedData => {
    const sub = subsetData();
    if (!sub) return [[], [], []];
    const fs = props.snapshot.fs;
    const tauR = props.snapshot.tauRise;
    const tauD = props.snapshot.tauDecay;
    const beta = props.snapshot.beta;
    const len = sub.hFree.length;

    const xAxis = new Array(len);
    const hFree = new Array(len);
    const fit = new Array(len);

    for (let i = 0; i < len; i++) {
      xAxis[i] = (i / fs) * 1000;
      hFree[i] = sub.hFree[i];
      const t = i / fs;
      fit[i] = beta * (Math.exp(-t / tauD) - Math.exp(-t / tauR));
    }

    return [xAxis, hFree, fit];
  });

  const subColor = () => D3_CATEGORY10[props.subsetIdx % D3_CATEGORY10.length];

  const series = createMemo((): uPlot.Series[] => [
    {},
    { label: `Subset ${props.subsetIdx}`, stroke: subColor(), width: 2 },
    { label: 'Merged fit', stroke: '#9467bd', width: 1.5, dash: [6, 3] },
  ]);

  const axes: uPlot.Axis[] = [
    { stroke: AXIS_TEXT, grid: { show: false }, ticks: { stroke: AXIS_TICK }, size: 24 },
    { stroke: AXIS_TEXT, grid: { stroke: AXIS_GRID }, ticks: { stroke: AXIS_TICK }, size: 30 },
  ];

  return (
    <div class="subset-kernel-fit">
      <SolidUplot
        data={chartData()}
        series={series()}
        scales={{ x: { time: false } }}
        axes={axes}
        cursor={{ drag: { x: false, y: false } }}
        height={100}
        autoResize={true}
      />
    </div>
  );
}
