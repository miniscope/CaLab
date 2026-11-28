import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import type { CellStore } from '../lib/cell-store.ts';
import { FLAG_LOW_SNR, FLAG_UNMEASURED, MIN_SNR, type QcSnapshot } from '../lib/qc.ts';
// uPlot (pulled in through @calab/ui/chart) needs a real browser (matchMedia).
vi.mock('uplot', () => ({ default: class {} }));
vi.mock('@dschz/solid-uplot', () => ({ SolidUplot: () => null }));

import { SelectedCellPanel } from '../components/CellsPanel.tsx';
import { CellMetricBars } from '../components/CellQcView.tsx';
import { qcRow } from './qc-fixtures.ts';

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.innerHTML = '';
});

function snapshot(): QcSnapshot {
  const rows = [
    qcRow({ id: 1, peakSnr: 12 }),
    qcRow({ id: 2, peakSnr: 3, flags: FLAG_LOW_SNR, pass: false }),
    qcRow({ id: 3, peakSnr: 300, maxNeighbourR: NaN }),
    qcRow({ id: 4, peakSnr: NaN, flags: FLAG_UNMEASURED, pass: false }),
  ];
  return { rows, byId: new Map(rows.map((r) => [r.id, r])) } as unknown as QcSnapshot;
}

/** A store with nothing selected; `select` only records (the selected view needs the full store). */
function fakeCells(qc: QcSnapshot | null) {
  const picked: (number | null)[] = [];
  const cells = {
    qc: () => qc,
    selected: () => null,
    select: (id: number | null) => picked.push(id),
    library: () => null,
    established: () => new Map<number, boolean>(),
  } as unknown as CellStore;
  return Object.assign(cells, { picked });
}

function mountIn(el: () => import('solid-js').JSX.Element): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  dispose = render(el, host);
  return host;
}

describe('Cell tab with nothing selected', () => {
  it('lists the measured cells by SNR, largest first, and a click selects one', () => {
    const cells = fakeCells(snapshot());
    const host = mountIn(() => <SelectedCellPanel cells={cells} fps={20} />);
    const rows = Array.from(host.querySelectorAll<HTMLElement>('[data-testid="cell-top-row"]'));
    expect(rows.map((r) => r.querySelector('.cala-top-cells__id')!.textContent)).toEqual([
      '#3',
      '#1',
      '#2',
    ]);
    rows[1].click();
    expect(cells.picked).toEqual([1]);
  });

  it('is one sentence before QC has measured any cell', () => {
    const host = mountIn(() => <SelectedCellPanel cells={fakeCells(null)} fps={20} />);
    expect(host.querySelector('[data-testid="cell-empty"]')!.textContent).toContain('Click a cell');
    expect(host.querySelector('[data-testid="cell-top-list"]')).toBeNull();
  });
});

describe('the selected cell metric bars', () => {
  it('draw each metric on its fixed range with the threshold tick; no data is a dash', () => {
    const host = mountIn(() => <CellMetricBars cells={fakeCells(snapshot())} id={3} />);
    const snr = host.querySelector('[data-testid="cell-metric-peakSnr"]')!;
    const meter = snr.querySelector('[role="meter"]')!;
    expect(meter.getAttribute('aria-valuemin')).toBe('1');
    expect(meter.getAttribute('aria-valuemax')).toBe('100');
    // Past the range: drawn at the end and flagged, the figure stays the true value.
    expect(meter.getAttribute('data-clamped')).toBe('over');
    expect(snr.textContent).toContain('300.0');
    const tick = snr.querySelector<HTMLElement>('.meter__tick')!;
    // Log scale: the threshold sits at log(MIN_SNR) / log(100) of the bar.
    expect(parseFloat(tick.style.left)).toBeCloseTo((100 * Math.log(MIN_SNR)) / Math.log(100), 3);
    // No threshold, no tick.
    expect(host.querySelector('[data-testid="cell-metric-projR"] .meter__tick')).toBeNull();
    // Not measured: a grey dash.
    expect(host.querySelector('[data-testid="cell-metric-maxNeighbourR"]')!.textContent).toContain(
      '–',
    );
    // No absolute scale: a figure without a bar.
    const fp = host.querySelector('[data-testid="cell-metric-fpError"]')!;
    expect(fp.querySelector('[role="meter"]')).toBeNull();
    expect(fp.textContent).toContain('0.10');
  });

  it('shows every metric as not measured for an unmeasured cell', () => {
    const host = mountIn(() => <CellMetricBars cells={fakeCells(snapshot())} id={4} />);
    expect(host.querySelectorAll('.meter--empty').length).toBe(6);
  });
});
