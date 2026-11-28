import { afterEach, describe, expect, it } from 'vitest';
import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import type { CellStore } from '../lib/cell-store.ts';
import { FLAG_LOW_SNR, FLAG_UNMEASURED, type QcSnapshot } from '../lib/qc.ts';
import { QcTable } from '../components/QcTable.tsx';
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
    qcRow({ id: 3, peakSnr: 9 }),
    qcRow({ id: 4, peakSnr: NaN, flags: FLAG_UNMEASURED, pass: false }),
  ];
  return { rows, byId: new Map(rows.map((r) => [r.id, r])) } as unknown as QcSnapshot;
}

function mount(qc: QcSnapshot | null) {
  const [selected, select] = createSignal<number | null>(null);
  const cells = {
    qc: () => qc,
    selected,
    select,
    established: () => new Map<number, boolean>(),
    fps: () => 20,
    stillMoving: () => new Map<number, number>(),
    stillMovingRatio: () => undefined,
  } as unknown as CellStore;
  const host = document.createElement('div');
  document.body.append(host);
  dispose = render(() => <QcTable cells={cells} />, host);
  const ids = () =>
    Array.from(host.querySelectorAll('[data-testid="qc-row"]')).map((r) =>
      r.querySelector('td')!.textContent!.trim(),
    );
  const q = (testid: string) => host.querySelector<HTMLElement>(`[data-testid="${testid}"]`)!;
  return { host, ids, q, selected };
}

describe('QC table', () => {
  it('says when QC has not started, without a summary bar', () => {
    const { q } = mount(null);
    expect(q('qc-counts').textContent).toContain('QC starts once');
    expect(q('qc-summary-bar')).toBeNull();
  });

  it('summarises pass / fail / not measured and filters by status', () => {
    const { ids, q } = mount(snapshot());
    expect(q('qc-summary-bar').getAttribute('aria-label')).toBe(
      'QC: pass 2, fail 1, not measured 1 of 4',
    );
    // Flagged first: failing, passing (by SNR ascending), then not measured.
    expect(ids()).toEqual(['#2', '#3', '#1', '#4']);
    q('qc-filter-fail').click();
    expect(ids()).toEqual(['#2']);
    expect(q('qc-filter-fail').getAttribute('aria-pressed')).toBe('true');
    // The bar fades every other part.
    const faded = Array.from(
      q('qc-summary-bar').querySelectorAll('.segmented-bar__part--faded'),
    ).map((p) => (p as HTMLElement).dataset.part);
    expect(faded).toEqual(['pass', 'unmeasured']);
    // Picking the active status again shows every cell.
    q('qc-filter-fail').click();
    expect(ids()).toHaveLength(4);
    // A click on the bar's part filters too.
    (q('qc-summary-bar').querySelector('[data-part="pass"]') as HTMLElement).click();
    expect(ids()).toEqual(['#3', '#1']);
    q('qc-filter-all').click();
    expect(ids()).toHaveLength(4);
  });

  it('shows one status mark per row, the SNR bar with its threshold, and picked columns', () => {
    const { host, q, selected } = mount(snapshot());
    const first = host.querySelector('[data-testid="qc-row"]')!;
    expect(first.querySelectorAll('.cala-qc-dot')).toHaveLength(1);
    expect(first.querySelector('.cala-qc-dot')!.getAttribute('aria-label')).toBe('fail');
    const meter = first.querySelector('[role="meter"]')!;
    expect(meter.getAttribute('aria-valuemax')).toBe('100');
    expect(first.querySelector('.meter__tick')).not.toBeNull();
    // The threshold and the population median are told apart and labelled once, in the header.
    expect(first.querySelector('.meter__median')).not.toBeNull();
    const key = host.querySelector('thead [data-testid="qc-bar-key"]')!.textContent!;
    expect(key).toContain('pass ≥ 5');
    expect(key).toContain('median');
    const heads = () =>
      Array.from(host.querySelectorAll('thead th')).map((t) =>
        (t.querySelector('button') ?? t).textContent!.replace(/ [▲▼]/, ''),
      );
    expect(heads()).toEqual(['Cell', 'SNR', 'Flag', 'nb r', 'proj r', 'motion R²']);
    expect(first.textContent).toContain('low SNR');
    const vif = q('qc-column-vif') as HTMLInputElement;
    vif.click();
    expect(heads()).toContain('vif');
    (q('qc-column-reason') as HTMLInputElement).click();
    expect(heads()).not.toContain('Flag');
    (first as HTMLElement).click();
    expect(selected()).toBe(2);
  });
});
