import { createMemo, type JSX } from 'solid-js';
import { OKABE_ITO, TracePanel } from '@calab/ui/chart';
import type uPlot from 'uplot';
import type { PipelineStore } from '../lib/pipeline-store.ts';

const SERIES: uPlot.Series[] = [
  {},
  { label: 'dy (px)', stroke: OKABE_ITO.blue, width: 1.25 },
  { label: 'dx (px)', stroke: OKABE_ITO.vermillion, width: 1.25 },
];

/** Rigid registering shift (dy, dx) against frame, growing as batches arrive. */
export function MotionTrace(props: { store: PipelineStore }): JSX.Element {
  // New arrays per update: the chart redraws when the data reference changes.
  const data = createMemo((): [number[], ...number[][]] => {
    props.store.traceVersion();
    const t = props.store.trace();
    return [t.frame.slice(), t.dy.slice(), t.dx.slice()];
  });

  return (
    <div class="cala-motion-trace" data-testid="motion-trace">
      <div class="cala-trace-head">
        <h3 class="panel-label">Rigid motion (recent frames, px)</h3>
        <span class="cala-legend">
          <span class="cala-legend__swatch" style={{ background: OKABE_ITO.blue }} />
          dy
          <span class="cala-legend__swatch" style={{ background: OKABE_ITO.vermillion }} />
          dx
        </span>
      </div>
      <TracePanel data={data} series={SERIES} height={130} syncKey="cala-motion" xLabel="Frame" />
    </div>
  );
}
