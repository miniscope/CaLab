import { describe, it, expect, afterEach, vi } from 'vitest';
import { render } from 'solid-js/web';
import { createSignal, type JSX } from 'solid-js';
import { SnrHistogramCard } from '../dataset/SnrHistogramCard.tsx';
import { EventHeightCard } from '../dataset/EventHeightCard.tsx';
import { BaselineCard } from '../dataset/BaselineCard.tsx';
import { QualityFlagList } from '../dataset/QualityFlagList.tsx';
import { ScatterCard } from '../dataset/ScatterCard.tsx';

// jsdom has no 2D canvas; ScatterCard skips drawing without a context.
HTMLCanvasElement.prototype.getContext = (() =>
  null) as typeof HTMLCanvasElement.prototype.getContext;

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
});

function mount(ui: () => JSX.Element): HTMLElement {
  const root = document.createElement('div');
  document.body.appendChild(root);
  dispose = render(ui, root);
  return root;
}

/** Pointer events with client coordinates (jsdom rects are all zero, so these are local). */
function drag(el: Element, x0: number, x1: number, y0 = 50, y1 = y0): void {
  const ev = (type: string, x: number, y: number) =>
    new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
  el.dispatchEvent(Object.assign(ev('pointerdown', x0, y0), { pointerId: 1 }));
  el.dispatchEvent(Object.assign(ev('pointermove', x1, y1), { pointerId: 1 }));
  el.dispatchEvent(Object.assign(ev('pointerup', x1, y1), { pointerId: 1 }));
}

const PROBS = Array.from({ length: 19 }, (_, i) => (i + 1) / 20);

describe('SnrHistogramCard', () => {
  it('renders bars, stats and the noise band, and brushes ids', () => {
    const onBrush = vi.fn();
    const snr = [3, 4, 5, 6, 8, 12, 20, 40];
    const root = mount(() => (
      <SnrHistogramCard
        snr={() => snr}
        noiseFloor={{ value: 2.7, hi: 3 }}
        silentCount={() => 1}
        nu={() => [1, 2, null, 3, 4, 5, 6, 7]}
        selected={() => 4}
        onBrush={onBrush}
      />
    ));
    expect(root.querySelectorAll('rect.ov-bar').length).toBeGreaterThan(3);
    expect(root.querySelector('rect.ov-shade')).not.toBeNull();
    const text = root.textContent ?? '';
    expect(text).toContain('median 7.0');
    expect(text).toContain('silent 1');
    expect(text).toContain('ν median 4');
    expect(text).toContain('#4');

    const svg = root.querySelector('svg.ov-svg')!;
    drag(svg, 0, 400);
    expect(onBrush).toHaveBeenCalledTimes(1);
    expect([...onBrush.mock.calls[0][0]].sort((a: number, b: number) => a - b)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7,
    ]);
    // A click (no drag) clears.
    drag(svg, 100, 101);
    expect(onBrush).toHaveBeenLastCalledWith(null);
  });

  it('omits ν without a ΔF/F declaration and opens its help', () => {
    const root = mount(() => (
      <SnrHistogramCard snr={() => [5, 6]} noiseFloor={{ value: 2.7, hi: 3 }} />
    ));
    expect(root.textContent).not.toContain('ν');
    const help = root.querySelector<HTMLButtonElement>('.ov-card__help-btn')!;
    help.click();
    expect(root.querySelector('.ov-card__help')?.textContent).toContain(
      'quantile within this dataset',
    );
  });

  it('overlays highlighted cells', () => {
    const [hl] = createSignal<ReadonlySet<number> | null>(new Set([0, 1]));
    const root = mount(() => (
      <SnrHistogramCard
        snr={() => [5, 5.1, 30]}
        noiseFloor={{ value: 2.7, hi: 3 }}
        highlighted={hl}
      />
    ));
    expect(root.querySelectorAll('rect.ov-bar--hl').length).toBeGreaterThan(0);
    expect(root.querySelector('rect.ov-bar--dim')).not.toBeNull();
  });
});

describe('EventHeightCard', () => {
  const pooled = {
    p10: PROBS.map((p) => 0.4 + p * 0.8),
    p50: PROBS.map((p) => 0.5 + p),
    p90: PROBS.map((p) => 0.6 + p * 1.4),
  };
  it('draws the band, the median and one curve per listed cell', () => {
    const root = mount(() => (
      <EventHeightCard
        probs={PROBS}
        pooled={() => pooled}
        curves={() => [
          { id: 7, quantiles: PROBS.map((p) => 0.2 + 3 * p), kind: 'flag' },
          { id: 2, quantiles: pooled.p50, kind: 'selected' },
        ]}
        nWithShape={() => 40}
      />
    ));
    expect(root.querySelector('path.ov-band')!.getAttribute('d')).toMatch(/^M.*Z$/);
    expect(root.querySelectorAll('path.ov-curve').length).toBe(2);
    expect(root.querySelector('path.ov-curve--flag')!.getAttribute('data-cell')).toBe('7');
    expect(root.textContent).toContain('N 40 cells');
  });
  it('shows a placeholder without enough events', () => {
    const root = mount(() => (
      <EventHeightCard probs={PROBS} pooled={() => null} curves={() => []} />
    ));
    expect(root.textContent).toContain('Too few events');
  });
});

describe('BaselineCard', () => {
  const data = (mode: 'ratio' | 'sigma') => ({
    mode,
    time: [5, 15, 25],
    median: [1, 0.99, 0.98],
    q25: [0.99, 0.98, NaN],
    q75: [1.01, 1, 0.99],
    drift: [0.98, 0.97, 1.0, 0.8],
  });
  it('labels ratio mode and draws the median and drift histogram', () => {
    const onBrush = vi.fn();
    const root = mount(() => <BaselineCard data={() => data('ratio')} onBrush={onBrush} />);
    expect(root.textContent).toContain('F₀ ÷ cell median');
    expect(root.textContent).toContain('end ÷ start');
    expect(root.querySelector('path.ov-line')!.getAttribute('d')).toMatch(/^M/);
    const svgs = root.querySelectorAll('svg.ov-svg');
    drag(svgs[svgs.length - 1], 0, 1000);
    expect(onBrush.mock.calls[0][0].length).toBe(4);
  });
  it('labels sigma mode and handles no data', () => {
    const root = mount(() => <BaselineCard data={() => data('sigma')} />);
    expect(root.textContent).toContain('Δ baseline (σ)');
    dispose?.();
    document.body.replaceChildren();
    const empty = mount(() => <BaselineCard data={() => null} />);
    expect(empty.textContent).toContain('No baseline estimate');
  });
});

describe('QualityFlagList', () => {
  it('lists counts, toggles a highlight and picks a cell', () => {
    const onSelect = vi.fn();
    const onPick = vi.fn();
    const [active, setActive] = createSignal<string | null>(null);
    const ids = Array.from({ length: 9 }, (_, i) => i * 3);
    const root = mount(() => (
      <QualityFlagList
        items={() => [
          { key: 'silent', label: 'Silent', description: 'none', ids },
          { key: 'gap', label: 'Gaps', description: 'nan', ids: [] },
        ]}
        activeKey={active}
        onSelect={(k, i) => {
          onSelect(k, i);
          setActive(k);
        }}
        onPick={onPick}
        totalCells={() => 100}
        flaggedCells={() => 9}
      />
    ));
    expect(root.textContent).toContain('9 of 100 cells flagged');
    expect(root.textContent).toContain('+3');
    const [silent, gap] = root.querySelectorAll<HTMLButtonElement>('.ov-flags__main');
    expect(gap.disabled).toBe(true);
    silent.click();
    expect(onSelect).toHaveBeenLastCalledWith('silent', ids);
    expect(silent.getAttribute('aria-pressed')).toBe('true');
    silent.click();
    expect(onSelect).toHaveBeenLastCalledWith(null, ids);
    root.querySelector<HTMLButtonElement>('.ov-flags__id')!.click();
    expect(onPick).toHaveBeenCalledWith(0);
  });
});

describe('ScatterCard', () => {
  it('draws the curve, band, shade and selected halo; brush and pick report ids', () => {
    const onBrush = vi.fn();
    const onPick = vi.fn();
    const root = mount(() => (
      <ScatterCard
        title="PVE vs SNR"
        x={() => [3, 10, 30, NaN, -1]}
        y={() => [0.2, 0.8, 0.95, 0.5, 0.5]}
        ids={() => [0, 1, 2, 3, 4]}
        xRange={() => [2, 50]}
        yRange={() => [0, 1]}
        logX
        xLabel="SNR"
        yLabel="PVE"
        yTickFormat={(v) => `${Math.round(v * 100)}%`}
        shade={{ lo: 0, hi: 3, label: 'noise' }}
        curve={() => ({ fn: (s) => s / (s + 5), lo: (s) => s / (s + 6), hi: (s) => s / (s + 4) })}
        selected={() => 1}
        onPick={onPick}
        onBrush={onBrush}
        tooltip={(id) => `Cell ${id}`}
      />
    ));
    expect(root.querySelector('path.ov-curve-main')!.getAttribute('d')).toMatch(/^M/);
    expect(root.querySelector('path.ov-curve-band')!.getAttribute('d')).toMatch(/Z$/);
    expect(root.querySelector('circle.ov-halo')).not.toBeNull();
    expect(root.textContent).toContain('100%');
    const fg = root.querySelector('svg.ov-svg--fg')!;
    drag(fg, 0, 1000, 0, 1000);
    expect(onBrush.mock.calls[0][0].sort()).toEqual([0, 1, 2]);
    // Click on point 1: find its pixel position from the halo.
    const halo = root.querySelector('circle.ov-halo')!;
    const cx = Number(halo.getAttribute('cx'));
    const cy = Number(halo.getAttribute('cy'));
    drag(fg, cx, cx, cy, cy);
    expect(onPick).toHaveBeenCalledWith(1);
    // Click on empty space clears.
    drag(fg, 1, 1, 1, 1);
    expect(onBrush).toHaveBeenLastCalledWith(null);
  });

  it('shows the empty text with no points', () => {
    const root = mount(() => (
      <ScatterCard
        title="t"
        x={() => []}
        y={() => []}
        ids={() => []}
        xRange={() => [0, 1]}
        yRange={() => [0, 1]}
        xLabel="x"
        yLabel="y"
        emptyText="Nothing yet"
      />
    ));
    expect(root.textContent).toContain('Nothing yet');
  });
});
