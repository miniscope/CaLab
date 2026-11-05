import { describe, it, expect, afterEach, vi } from 'vitest';
import { render } from 'solid-js/web';
import { createSignal, type JSX } from 'solid-js';
import { SnrHistogramCard } from '../dataset/SnrHistogramCard.tsx';
import { EventHeightCard, heightBandSpread, heightVerdict } from '../dataset/EventHeightCard.tsx';
import { ChartLegend } from '../dataset/ChartLegend.tsx';
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
    expect(text).toContain('Signal strength (SNR)');
    expect(text).toContain('stands above its noise');
    expect(text).toContain('pure noise');
    expect(text).toContain('SNR (log scale)');
    expect(text).toContain('cells');
    expect(root.querySelector('.ov-legend [data-mark="gradient"]')).not.toBeNull();
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
    const text = root.textContent ?? '';
    expect(text).toContain('N 40');
    expect(text).toContain('Event-size consistency');
    expect(text).toContain("event height ÷ cell's median event");
    expect(text).toContain('fraction of events below');
    // Legend lists only the marks present: no "highlighted" curve here.
    const legend = root.querySelector('.ov-legend')!.textContent ?? '';
    expect(legend).toContain('median cell');
    expect(legend).toContain('10–90 % of cells');
    expect(legend).toContain('flagged cell');
    expect(legend).toContain('inspected');
    expect(legend).not.toContain('highlighted');
  });

  it('reads the band width at the 90th-percentile event', () => {
    // p = .9 is index 17: p10 = 0.4 + .9·0.8 = 1.12, p90 = 0.6 + .9·1.4 = 1.86.
    expect(heightBandSpread(PROBS, pooled)).toBeCloseTo(1.86 / 1.12, 6);
    expect(heightBandSpread(PROBS, null)).toBeNaN();
    expect(heightVerdict(1.5, 60)).toBe('consistent');
    expect(heightVerdict(2.5, 60)).toBe('varies');
    expect(heightVerdict(2.5, 10)).toBe('few-events');
    expect(heightVerdict(NaN, 60)).toBeNull();
  });

  it('states the takeaway under the plot', () => {
    const wide = { ...pooled, p90: PROBS.map((p) => 0.6 + p * 4) };
    const root = mount(() => (
      <EventHeightCard
        probs={PROBS}
        pooled={() => wide}
        curves={() => []}
        medianEvents={() => 80}
      />
    ));
    const t = root.querySelector('[data-testid="overview-heights-takeaway"]')!;
    expect(t.textContent).toContain('compare SNR with care');
    expect(t.classList.contains('ov-takeaway--warn')).toBe(true);
  });

  it('gives no verdict with few events per cell', () => {
    const root = mount(() => (
      <EventHeightCard
        probs={PROBS}
        pooled={() => pooled}
        curves={() => []}
        medianEvents={() => 8}
      />
    ));
    expect(root.textContent).toContain('Too few events per cell (median 8)');
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
    const text = root.textContent ?? '';
    expect(text).toContain('Baseline stability');
    expect(text).toContain('F₀ ÷ cell median');
    expect(text).toContain('end ÷ start');
    expect(text).toContain('typical baseline');
    expect(text).toContain('middle 50 % of cells');
    // Reference line at the typical value (1 in ratio mode).
    const ref = root.querySelector('line.ov-ref')!;
    expect(ref.getAttribute('y1')).toBe(ref.getAttribute('y2'));
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
    expect(root.textContent).toContain('Cells that may need a look');
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
        shade={{ lo: 0, hi: 3, label: 'noise', legendLabel: 'noise floor' }}
        curve={() => ({
          fn: (s) => s / (s + 5),
          lo: (s) => s / (s + 6),
          hi: (s) => s / (s + 4),
          label: 'best expected',
          legendLabel: 'ceiling',
        })}
        styleOf={(id) => (id === 0 ? 'strong' : id === 2 ? 'flag' : 'default')}
        pointLabels={{
          strong: 'used for kernel fit',
          default: 'other',
          flag: 'flagged',
          accent: 'highlighted',
        }}
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
    expect(root.querySelector('text.ov-curve-label')?.textContent).toBe('best expected');
    const legend = root.querySelector('.ov-legend')!.textContent ?? '';
    for (const l of ['used for kernel fit', 'other', 'flagged', 'ceiling', 'noise floor']) {
      expect(legend).toContain(l);
    }
    // No point is accent-styled, so "highlighted" is not listed.
    expect(legend).not.toContain('highlighted');
    expect(root.querySelector('.ov-legend [data-mark="ring"]')).not.toBeNull();
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

describe('ChartLegend', () => {
  it("draws each swatch with the plot element's class or colour", () => {
    const root = mount(() => (
      <ChartLegend
        items={[
          { mark: 'line', className: 'ov-line', label: 'median' },
          { mark: 'area', className: 'ov-band', label: 'band' },
          { mark: 'dot', color: 'var(--ov-point)', label: 'dot' },
        ]}
      />
    ));
    expect(root.querySelector('.ov-legend line.ov-line')).not.toBeNull();
    expect(root.querySelector('.ov-legend rect.ov-band')).not.toBeNull();
    expect(root.querySelector<SVGCircleElement>('.ov-legend circle')!.style.fill).toBe(
      'var(--ov-point)',
    );
    expect(root.querySelectorAll('.ov-legend__item').length).toBe(3);
  });
});
