import { createMemo, type JSX } from 'solid-js';
import { OKABE_ITO, TracePanel } from '@calab/ui/chart';
import type uPlot from 'uplot';
import type { PipelineStore } from '../lib/pipeline-store.ts';

const SERIES: uPlot.Series[] = [
  {},
  { label: 'gain m (%)', stroke: OKABE_ITO.bluishGreen, width: 1.25 },
  { label: 'offset a (grey levels)', stroke: OKABE_ITO.reddishPurple, width: 1.25 },
];

/**
 * Global flicker removed per frame, against frame: the LED gain m_t (percent)
 * and the sensor offset a_t (grey levels), relative to the last ~second.
 */
export function FlickerTrace(props: { store: PipelineStore }): JSX.Element {
  // New arrays per update: the chart redraws when the data reference changes.
  const data = createMemo((): [number[], ...number[][]] => {
    props.store.traceVersion();
    const t = props.store.trace();
    return [t.frame.slice(), t.gainPct.slice(), t.offset.slice()];
  });

  return (
    <div class="cala-motion-trace" data-testid="flicker-trace">
      <div class="cala-trace-head">
        <h3 class="panel-label">Global flicker (removed per frame)</h3>
        <span class="cala-legend">
          <span class="cala-legend__swatch" style={{ background: OKABE_ITO.bluishGreen }} />
          gain m (%)
          <span class="cala-legend__swatch" style={{ background: OKABE_ITO.reddishPurple }} />
          offset a (grey levels)
        </span>
      </div>
      <TracePanel data={data} series={SERIES} height={130} syncKey="cala-motion" xLabel="Frame" />
    </div>
  );
}
