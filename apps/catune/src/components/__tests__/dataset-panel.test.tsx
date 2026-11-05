// @vitest-environment jsdom
/**
 * Dataset drawer tab and SNR badge: the shared SNR cards render from the overview,
 * the table's SNR column comes from the overview, and a length-mismatched fit is
 * surfaced as "--" plus a note instead of a silent 0.
 */

import { describe, it, expect, afterEach, vi, beforeAll } from 'vitest';

// uPlot (pulled in by @calab/ui/chart) reads matchMedia at import time; jsdom has none.
vi.hoisted(() => {
  globalThis.matchMedia ??= (() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof matchMedia;
});
import { render } from 'solid-js/web';
import type { OverviewPoolJob } from '../../lib/overview-pool.ts';
import type { CellOverview } from '@calab/core';

vi.mock('../../lib/overview-pool.ts', () => ({
  createOverviewWorkerPool: () => ({
    size: 1,
    dispatch(job: OverviewPoolJob) {
      queueMicrotask(() => {
        const cells: CellOverview[] = Array.from({ length: job.nCells }, (_, k) => ({
          snr: 2.5 + job.tracesFlat[k * job.nTimepoints],
          sigma: 1,
          nu: null,
          nEvents: 6,
          isSilent: k === 0 && job.tracesFlat[0] === 0,
          eventRateHz: 0.1,
          medianEventHeight: 2,
          heightQuantiles: [],
          baselineBins: [1, 1],
          baselineStart: 1,
          baselineEnd: 1,
          nAtMax: 1,
          clipFraction: 0,
          nanCount: 0,
          longestGapFrames: 0,
        }));
        job.onComplete(cells);
      });
    },
    cancel() {},
    cancelAll() {},
    dispose() {},
  }),
}));

import { DatasetPanel } from '../metrics/DatasetPanel.tsx';
import { QualityBadge } from '../metrics/QualityBadge.tsx';
import { computeOverview } from '../../lib/overview-store.ts';
import {
  setParsedData,
  setDimensionsConfirmed,
  setSamplingRate,
  setSwapped,
} from '../../lib/data-store.ts';
import { setMultiCellResults, setCellSolverStatuses } from '../../lib/multi-cell-store.ts';
import { setActiveSidebarTab } from '../layout/SidebarTabs.tsx';

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() =>
    null) as typeof HTMLCanvasElement.prototype.getContext;
});

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
});

function mount(ui: () => import('solid-js').JSX.Element): HTMLElement {
  const root = document.createElement('div');
  document.body.appendChild(root);
  dispose = render(ui, root);
  return root;
}

describe('QualityBadge', () => {
  it('shows "SNR x.x" as its own label and a separate "≈ noise" tag', () => {
    const root = mount(() => (
      <QualityBadge snr={2.7} rank={0.1} nCells={20} solverStatus="fresh" />
    ));
    expect(root.querySelector('.quality-badge__label')!.textContent).toBe('SNR 2.7');
    expect(root.querySelector('.quality-badge__tag')!.textContent).toBe('≈ noise');
    expect(root.querySelector('.quality-badge')!.getAttribute('title')).toMatch(
      /10th percentile of 20 cells/,
    );
  });

  it('has no tag for a healthy cell and no SNR while the overview is pending', () => {
    const healthy = mount(() => <QualityBadge snr={9.2} rank={0.9} solverStatus="fresh" />);
    expect(healthy.querySelector('.quality-badge__tag')).toBeNull();
    dispose?.();
    document.body.replaceChildren();
    const pending = mount(() => <QualityBadge solverStatus="fresh" iterationCount={4} />);
    expect(pending.querySelector('.quality-badge__label')!.textContent).toBe('Done (4)');
  });
});

describe('DatasetPanel', () => {
  it('renders the SNR card, the flag summary and a table SNR from the overview; surfaces a fit mismatch', async () => {
    const nCells = 12;
    const nT = 40;
    const data = new Float64Array(nCells * nT);
    for (let c = 0; c < nCells; c++) for (let t = 0; t < nT; t++) data[c * nT + t] = c;
    setParsedData({ data, shape: [nCells, nT], dtype: '<f8', fortranOrder: false });
    setDimensionsConfirmed(true);
    setSwapped(false);
    setSamplingRate(30);
    await computeOverview();

    // One solved cell whose working trace (windowed) and fit lengths disagree.
    setMultiCellResults(5, {
      cellIndex: 5,
      raw: new Float64Array(nT),
      rawStats: { mean: 0, std: 1, zMin: 0, zMax: 0 },
      deconvolved: new Float32Array(10),
      deconvMinMax: [0, 0],
      reconvolution: new Float32Array(10),
      filteredTrace: new Float32Array(nT),
    });
    setCellSolverStatuses(5, 'fresh');

    // The panel only recomputes its table while the Dataset tab is visible.
    setActiveSidebarTab('dataset');
    const root = mount(() => <DatasetPanel />);

    expect(root.querySelector('h3')!.textContent).toBe('Dataset');
    expect(root.querySelector('[data-testid="overview-snr"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="flag-summary"]')!.textContent).toMatch(
      /flagged|No cells flagged/,
    );
    expect(root.textContent).toContain('Median SNR');

    // Table SNR comes from the overview (cell 5: 2.5 + 5 = 7.5), the mismatched fit shows "--" and a note.
    const row = root.querySelector(
      '.metrics-panel__table .metrics-panel__row:not(.metrics-panel__row--header)',
    )!;
    const cols = [...row.children].map((c) => c.textContent!.trim());
    expect(cols[0]).toBe('6');
    expect(cols[1]).toBe('7.5');
    expect(cols[2]).toBe('--');
    expect(root.querySelector('[data-testid="fit-unavailable"]')!.textContent).toMatch(
      /R² unavailable for 1 cell.*10 samples.*40 samples/,
    );
  });
});
