import { describe, it, expect, afterEach, vi } from 'vitest';
import { render } from 'solid-js/web';
import { createSignal } from 'solid-js';
import { StreamHistory } from '@calab/compute';
import { HistoryPlot } from '../chart/HistoryPlot.tsx';
import { expansionMarks, normalise, rangeText } from '../chart/history-geometry.ts';

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
});

function makeHistory(): StreamHistory {
  const h = new StreamHistory();
  h.define({
    key: 'cells',
    label: 'Cell count',
    short: 'Cells',
    unit: 'cells',
    group: 'convergence',
    kind: 'value',
    range: [0, 200],
    rangeRule: 'fixed',
    color: '#e69f00',
    digits: 0,
    hint: 'accepted cells',
  });
  h.define({
    key: 'dy',
    label: 'Shift dy',
    short: 'dy',
    unit: 'px',
    group: 'motion',
    kind: 'value',
    range: [-10, 10],
    rangeRule: 'ladder125',
    color: '#0072b2',
    digits: 1,
  });
  for (let t = 0; t < 30; t++) {
    h.push('cells', t, 100 + t);
    h.push('dy', t, t === 20 ? 15 : 1.5);
  }
  h.advance(30);
  return h;
}

function mount(fn: () => import('solid-js').JSX.Element): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  dispose = render(fn, host);
  return host;
}

const chips = (host: HTMLElement) =>
  Array.from(host.querySelectorAll<HTMLButtonElement>('.history-chip'));

const base = {
  window: () => ({ t0: 0, t1: 30 }),
  now: () => 30,
  tick: () => 0,
  height: 130,
};

describe('HistoryPlot DOM', () => {
  it('renders one chip per series with the latest value and aria-pressed', () => {
    const h = makeHistory();
    const host = mount(() => (
      <HistoryPlot {...base} history={() => h} keys={['cells', 'dy']} testid="hp" />
    ));
    const c = chips(host);
    expect(c).toHaveLength(2);
    expect(c[0].textContent).toContain('Cells');
    expect(c[0].textContent).toContain(String(Math.round(h.latest('cells'))));
    expect(c[0].getAttribute('aria-pressed')).toBe('true');
    expect(c[1].getAttribute('aria-pressed')).toBe('false');
    expect(host.querySelector('canvas')?.getAttribute('role')).toBe('img');
    expect(host.querySelector('[data-testid="hp"]')).toBeTruthy();
  });

  it('selects by click and cycles with arrow keys, reporting onSelect', () => {
    const h = makeHistory();
    const onSelect = vi.fn();
    const host = mount(() => (
      <HistoryPlot {...base} history={() => h} keys={['cells', 'dy']} onSelect={onSelect} />
    ));
    chips(host)[1].click();
    expect(onSelect).toHaveBeenLastCalledWith('dy');
    expect(chips(host)[1].getAttribute('aria-pressed')).toBe('true');
    const wrap = host.querySelector('.history-wrap') as HTMLElement;
    wrap.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(onSelect).toHaveBeenLastCalledWith('cells');
    wrap.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(onSelect).toHaveBeenLastCalledWith('dy');
    expect(chips(host)[1].getAttribute('aria-pressed')).toBe('true');
  });

  it('supports a controlled selection', () => {
    const h = makeHistory();
    const [sel, setSel] = createSignal('dy');
    const host = mount(() => (
      <HistoryPlot
        {...base}
        history={() => h}
        keys={['cells', 'dy']}
        selected={sel}
        onSelect={setSel}
      />
    ));
    expect(chips(host)[1].getAttribute('aria-pressed')).toBe('true');
    setSel('cells');
    expect(chips(host)[0].getAttribute('aria-pressed')).toBe('true');
  });

  it('shows the inspected value and clears it on Escape', () => {
    const h = makeHistory();
    const [insp, setInsp] = createSignal<number | null>(5);
    const host = mount(() => (
      <HistoryPlot
        {...base}
        history={() => h}
        keys={['cells']}
        inspected={insp}
        onInspect={setInsp}
      />
    ));
    expect(chips(host)[0].querySelector('.history-chip__val--insp')).toBeTruthy();
    expect(chips(host)[0].textContent).toContain('105');
    (host.querySelector('.history-wrap') as HTMLElement).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    expect(insp()).toBeNull();
    expect(chips(host)[0].querySelector('.history-chip__val--insp')).toBeNull();
  });

  it('chip title carries label, range, unit, hint and range expansions', () => {
    const h = makeHistory();
    const host = mount(() => <HistoryPlot {...base} history={() => h} keys={['cells', 'dy']} />);
    const t0 = chips(host)[0].title;
    expect(t0).toContain('Cell count');
    expect(t0).toContain('0–200 cells');
    expect(t0).toContain('accepted cells');
    const t1 = chips(host)[1].title;
    expect(t1).toContain('range expanded from ±10 px');
    expect(t1).toContain('±20 px');
  });

  it('toggles the legend; compact hides the button', () => {
    const h = makeHistory();
    const host = mount(() => <HistoryPlot {...base} history={() => h} keys={['cells']} />);
    const help = host.querySelector<HTMLButtonElement>('.history-help')!;
    expect(host.querySelector('.history-legend')).toBeNull();
    help.click();
    expect(host.querySelector('.history-legend')).toBeTruthy();
    dispose?.();
    document.body.replaceChildren();
    const c = mount(() => <HistoryPlot {...base} history={() => h} keys={['cells']} compact />);
    expect(c.querySelector('.history-help')).toBeNull();
  });

  it('renders without a history', () => {
    const host = mount(() => <HistoryPlot {...base} history={() => null} keys={['cells']} />);
    expect(chips(host)).toHaveLength(0);
  });
});

describe('range geometry helpers', () => {
  it('normalises against the fixed range without clipping', () => {
    expect(normalise(100, { lo: 0, hi: 200 })).toBe(0.5);
    expect(normalise(-10, { lo: -20, hi: 20 })).toBe(0.25);
    expect(normalise(300, { lo: 0, hi: 200 })).toBe(1.5);
    expect(normalise(1, { lo: 1, hi: 1 })).toBe(0.5);
  });
  it('formats ranges', () => {
    expect(rangeText(0, 200, 'cells')).toBe('0–200 cells');
    expect(rangeText(-10, 10, 'px')).toBe('±10 px');
  });
  it('places old-limit markers against the current range', () => {
    const marks = expansionMarks(
      {
        lo: -20,
        hi: 20,
        initial: [-10, 10],
        expansions: [{ t: 11400, from: [-10, 10], to: [-20, 20] }],
        clipped: false,
      },
      'px',
      86400 * 3,
    );
    expect(marks).toHaveLength(2);
    expect(marks[0].u).toBe(0.75);
    expect(marks[1].u).toBe(0.25);
    expect(marks[0].label).toBe('range expanded from ±10 px at d0 03:10:00');
  });
  it('a one-sided step gives a single marker', () => {
    const marks = expansionMarks({
      lo: 0,
      hi: 200,
      initial: [0, 100],
      expansions: [{ t: 5, from: [0, 100], to: [0, 200] }],
      clipped: false,
    });
    expect(marks).toHaveLength(1);
    expect(marks[0].u).toBe(0.5);
  });
});
