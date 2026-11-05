/**
 * Results tab: PVE (y) against the model-free measured SNR (x, log) with one
 * dataset-level ceiling curve, plus the alpha and event-rate distributions.
 * Clicking a point inspects that cell; dragging a rectangle highlights cells.
 */

import { createMemo, type JSX } from 'solid-js';
import { OVERVIEW_PARAMS, ceilingAt, MIN_CEILING_CELLS } from '@calab/core';
import { ScatterCard, snrDomain, type PointStyle } from '@calab/ui/dataset';
import '@calab/ui/dataset/dataset.css';
import { AlphaDistribution } from './AlphaDistribution.tsx';
import { EventRateDistribution } from './EventRateDistribution.tsx';
import { cellResultLookup } from '../../lib/iteration-store.ts';
import { overview } from '../../lib/overview-store.ts';
import { subsetRectangles } from '../../lib/subset-store.ts';
import {
  highlightedCells,
  setHighlightedCells,
  inspectedCellIndex,
  setInspectedCellIndex,
} from '../../lib/viz-store.ts';
import {
  pveSnrPoints,
  fitFromPoints,
  ceilingBand,
  ceilingVerdict,
  VERDICT_TEXT,
} from '../../lib/results-ceiling.ts';

const pct = (v: number) => `${Math.round(v * 100)}%`;

export function ResultsPanel(): JSX.Element {
  const snr = createMemo(() => overview()?.cells.map((c) => c.snr) ?? null);
  const points = createMemo(() => pveSnrPoints(cellResultLookup(), snr()));
  const fit = createMemo(() => fitFromPoints(points()));

  const subsetCells = createMemo(() => {
    const set = new Set<number>();
    for (const r of subsetRectangles()) for (let c = r.cellStart; c < r.cellEnd; c++) set.add(c);
    return set;
  });
  const flagged = createMemo(() => {
    const set = new Set<number>();
    overview()?.flags.forEach((f, i) => {
      if (f.length > 0) set.add(i);
    });
    return set;
  });

  const styleOf = (id: number): PointStyle => {
    const hl = highlightedCells();
    if (hl) return hl.has(id) ? 'accent' : 'dim';
    if (flagged().has(id)) return 'flag';
    return subsetCells().has(id) ? 'strong' : 'default';
  };

  const xRange = createMemo(() => snrDomain(snr() ?? [], OVERVIEW_PARAMS.noiseFloorSnr));

  const tooltip = (id: number) => {
    const p = points().find((q) => q.cell === id);
    if (!p) return `Cell ${id}`;
    const f = fit();
    const lines = [`Cell ${id}`, `SNR ${p.snr.toFixed(1)} · PVE ${pct(p.pve)}`];
    if (f) {
      lines.push(`ceiling ${pct(ceilingAt(f.c, p.snr))}`);
      lines.push(VERDICT_TEXT[ceilingVerdict(f, p.snr, p.pve)]);
    }
    const fl = overview()?.flags[id];
    if (fl && fl.length) lines.push(`flags: ${fl.join(', ')}`);
    return lines.join('\n');
  };

  return (
    <div class="results-grid">
      <ScatterCard
        title="PVE vs SNR"
        data-testid="results-pve-snr"
        x={() => points().map((p) => p.snr)}
        y={() => points().map((p) => p.pve)}
        ids={() => points().map((p) => p.cell)}
        xRange={xRange}
        yRange={() => [0, 1]}
        logX
        xLabel="measured SNR (log)"
        yLabel="PVE"
        yTickFormat={pct}
        shade={{ lo: 0, hi: OVERVIEW_PARAMS.noiseFloorBandHi, label: 'no detectable activity' }}
        curve={() => {
          if (!fit()) return null;
          return {
            fn: (s: number) => ceilingBand(fit()!, s).mid,
            lo: (s: number) => ceilingBand(fit()!, s).lo,
            hi: (s: number) => ceilingBand(fit()!, s).hi,
          };
        }}
        styleOf={styleOf}
        selected={inspectedCellIndex}
        onPick={setInspectedCellIndex}
        onBrush={(ids) => setHighlightedCells(ids, 'pve-snr')}
        tooltip={tooltip}
        emptyText={
          snr() ? 'Run deconvolution to see PVE per cell' : 'Waiting for the dataset overview'
        }
        help={
          <>
            <p>
              Each point is a cell: PVE of its fit (y) against its model-free measured SNR (x, log).
              The curve is one dataset-level ceiling, PVE = c·SNR²/(c·SNR²+1), with c fitted across
              cells to each cell's processed-space ceiling 1 − σ²_proc/Var(working trace) from the
              solver's noise budget, never to the observed PVE. Band: ±1 SE of log c.
            </p>
            <p>
              Points near the curve fit about as well as the noise allows; points well below may
              have hit a fallback or misfit; points above may be fitting noise. Darker points are in
              kernel-estimation subsets, red rings are flagged cells. Click a point to inspect it;
              drag to highlight cells.
            </p>
          </>
        }
        footer={
          <>
            <span>N {points().length}</span>
            <span>
              {fit()
                ? `c = ${fit()!.c.toPrecision(3)} (n = ${fit()!.n})`
                : `curve after ${MIN_CEILING_CELLS} cells with a noise floor`}
            </span>
          </>
        }
      />
      <div class="results-grid__side">
        <AlphaDistribution />
        <EventRateDistribution />
      </div>
    </div>
  );
}
