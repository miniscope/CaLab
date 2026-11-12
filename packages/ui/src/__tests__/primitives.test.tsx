import { describe, it, expect, afterEach, vi } from 'vitest';
import { render } from 'solid-js/web';
import { createSignal } from 'solid-js';
import { TabStrip, Tabs } from '../Tabs.tsx';
import { SegmentedControl } from '../SegmentedControl.tsx';
import { ProgressBar } from '../ProgressBar.tsx';
import { MetricTile, sparkPath, sparkRange } from '../MetricTile.tsx';

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
});

function mount(fn: () => import('solid-js').JSX.Element): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  dispose = render(fn, host);
  return host;
}

const tabButtons = (host: HTMLElement) =>
  Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
const panels = (host: HTMLElement) =>
  Array.from(host.querySelectorAll<HTMLElement>('[role="tabpanel"]'));

describe('TabStrip', () => {
  it('marks the active tab, reports selection, renders trailing and testids', () => {
    const onSelect = vi.fn();
    const host = mount(() => (
      <TabStrip
        tabs={[
          { id: 'a', label: 'A', testid: 'tab-a', title: 'first' },
          { id: 'b', label: 'B' },
        ]}
        active="b"
        onSelect={onSelect}
        variant="caps"
        class="extra"
        trailing={<i data-testid="trail" />}
        aria-label="Sections"
      />
    ));
    const strip = host.querySelector('[role="tablist"]')!;
    expect(strip.className).toBe('tab-strip tab-strip--caps extra');
    expect(strip.getAttribute('aria-label')).toBe('Sections');
    const [a, b] = tabButtons(host);
    expect(a.getAttribute('aria-selected')).toBe('false');
    expect(b.getAttribute('aria-selected')).toBe('true');
    expect(b.classList.contains('tab-strip__tab--active')).toBe(true);
    expect(a.getAttribute('data-testid')).toBe('tab-a');
    expect(a.title).toBe('first');
    expect(host.querySelector('.tab-strip__trailing [data-testid="trail"]')).not.toBeNull();
    a.click();
    expect(onSelect).toHaveBeenCalledWith('a');
  });

  it('defaults to the underline variant', () => {
    const host = mount(() => <TabStrip tabs={[]} active={null} onSelect={() => {}} />);
    expect(host.querySelector('.tab-strip--underline')).not.toBeNull();
  });
});

describe('Tabs', () => {
  const items = (spy?: () => void) => [
    {
      id: 'a',
      label: 'Alpha',
      content: () => {
        spy?.();
        return <p>content a</p>;
      },
    },
    { id: 'b', label: 'Beta', content: <p>content b</p> },
  ];

  it('is uncontrolled: seeds from defaultTab and switches on click', () => {
    const onChange = vi.fn();
    const host = mount(() => <Tabs tabs={items()} defaultTab="b" onChange={onChange} />);
    expect(tabButtons(host)[1].getAttribute('aria-selected')).toBe('true');
    tabButtons(host)[0].click();
    expect(tabButtons(host)[0].getAttribute('aria-selected')).toBe('true');
    expect(onChange).toHaveBeenCalledWith('a');
  });

  it('starts on the first tab without defaultTab', () => {
    const host = mount(() => <Tabs tabs={items()} />);
    expect(tabButtons(host)[0].getAttribute('aria-selected')).toBe('true');
  });

  it('is controlled when active is given: only the prop moves the selection', () => {
    const [active, setActive] = createSignal('a');
    const onChange = vi.fn();
    const host = mount(() => <Tabs tabs={items()} active={active()} onChange={onChange} />);
    tabButtons(host)[1].click();
    expect(onChange).toHaveBeenCalledWith('b');
    expect(tabButtons(host)[0].getAttribute('aria-selected')).toBe('true');
    setActive('b');
    expect(tabButtons(host)[1].getAttribute('aria-selected')).toBe('true');
  });

  it('keepMounted hides inactive panels, uses panelDisplay and labels panels', () => {
    const host = mount(() => <Tabs tabs={items()} panelDisplay="contents" />);
    const [pa, pb] = panels(host);
    expect(pa.style.display).toBe('contents');
    expect(pb.style.display).toBe('none');
    expect(pa.getAttribute('aria-label')).toBe('Alpha');
    tabButtons(host)[1].click();
    expect(pa.style.display).toBe('none');
    expect(pb.style.display).toBe('contents');
  });

  it('keepMounted=false mounts only the active panel', () => {
    const host = mount(() => <Tabs tabs={items()} keepMounted={false} />);
    expect(panels(host)).toHaveLength(1);
    expect(host.textContent).toContain('content a');
    tabButtons(host)[1].click();
    expect(panels(host)).toHaveLength(1);
    expect(host.textContent).toContain('content b');
  });

  it('resolves factory content once, however often the tab changes', () => {
    const spy = vi.fn();
    const host = mount(() => <Tabs tabs={items(spy)} />);
    expect(spy).toHaveBeenCalledTimes(1);
    tabButtons(host)[1].click();
    tabButtons(host)[0].click();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('SegmentedControl', () => {
  const options = [
    { value: 'x', label: 'X' },
    { value: 'y', label: 'Y', disabled: true },
    { value: 'z', label: 'Z', title: 'zed', testid: 'opt-z' },
  ];
  const radios = (host: HTMLElement) =>
    Array.from(host.querySelectorAll<HTMLButtonElement>('[role="radio"]'));

  it('renders radio semantics and reports clicks', () => {
    const onChange = vi.fn();
    const host = mount(() => (
      <SegmentedControl
        options={options}
        value="x"
        onChange={onChange}
        aria-label="Mode"
        size="sm"
        testid="seg"
      />
    ));
    const group = host.querySelector('[role="radiogroup"]')!;
    expect(group.className).toBe('segmented segmented--sm');
    expect(group.getAttribute('aria-label')).toBe('Mode');
    expect(group.getAttribute('data-testid')).toBe('seg');
    const [x, y, z] = radios(host);
    expect(x.getAttribute('aria-checked')).toBe('true');
    expect(x.classList.contains('segmented__option--active')).toBe(true);
    expect(z.title).toBe('zed');
    expect(z.getAttribute('data-testid')).toBe('opt-z');
    expect(y.disabled).toBe(true);
    z.click();
    expect(onChange).toHaveBeenCalledWith('z');
  });

  it('arrow keys move selection, skipping disabled options and wrapping', () => {
    const onChange = vi.fn();
    const host = mount(() => (
      <SegmentedControl options={options} value="x" onChange={onChange} aria-label="Mode" />
    ));
    const group = host.querySelector('[role="radiogroup"]')!;
    group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(onChange).toHaveBeenLastCalledWith('z');
    group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(onChange).toHaveBeenLastCalledWith('z'); // wraps past nothing: x -> z
    onChange.mockClear();
    group.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('ProgressBar', () => {
  const track = (host: HTMLElement) => host.querySelector('.progress-bar__track')!;
  const fill = (host: HTMLElement) => host.querySelector('.progress-bar__fill')!;

  it('shows label, rounded pct and aria values', () => {
    const host = mount(() => (
      <ProgressBar fraction={0.456} label="Step 1" state="running" aria-label="Run" />
    ));
    expect(host.querySelector('.progress-bar__pct')!.textContent).toBe('46%');
    expect(host.querySelector('.progress-bar__label')!.textContent).toContain('Step 1');
    const t = track(host);
    expect(t.getAttribute('role')).toBe('progressbar');
    expect(t.getAttribute('aria-valuemin')).toBe('0');
    expect(t.getAttribute('aria-valuemax')).toBe('100');
    expect(t.getAttribute('aria-valuenow')).toBe('46');
    expect(t.getAttribute('aria-label')).toBe('Run');
    expect((fill(host) as HTMLElement).style.width).toBe('46%');
  });

  it('clamps the fraction', () => {
    const over = mount(() => <ProgressBar fraction={3} />);
    expect(track(over).getAttribute('aria-valuenow')).toBe('100');
    dispose?.();
    document.body.replaceChildren();
    const under = mount(() => <ProgressBar fraction={-1} />);
    expect(track(under).getAttribute('aria-valuenow')).toBe('0');
  });

  it('omits the label row without a label and the pct with showPct=false', () => {
    const none = mount(() => <ProgressBar fraction={0.5} />);
    expect(none.querySelector('.progress-bar__label')).toBeNull();
    dispose?.();
    document.body.replaceChildren();
    const nopct = mount(() => <ProgressBar fraction={0.5} label="L" showPct={false} />);
    expect(nopct.querySelector('.progress-bar__pct')).toBeNull();
  });

  it.each([
    ['idle', false, null],
    ['stopping', false, null],
    ['running', true, null],
    ['paused', false, 'progress-bar__fill--paused'],
    ['complete', false, 'progress-bar__fill--complete'],
    ['error', false, 'progress-bar__fill--error'],
  ] as const)('state %s sets the right classes', (state, pulses, modifier) => {
    const host = mount(() => <ProgressBar fraction={0.2} state={state} />);
    expect(track(host).classList.contains('progress-bar__track--running')).toBe(pulses);
    const mods = Array.from(fill(host).classList).filter((c) =>
      c.startsWith('progress-bar__fill--'),
    );
    expect(mods).toEqual(modifier ? [modifier] : []);
  });

  it('renders phase and status lines only when given', () => {
    const host = mount(() => <ProgressBar fraction={0.2} phase="Merging" status="Paused" />);
    expect(host.querySelector('.progress-bar__phase')!.textContent).toBe('Merging');
    expect(host.querySelector('.progress-bar__status')!.textContent).toBe('Paused');
    dispose?.();
    document.body.replaceChildren();
    const bare = mount(() => <ProgressBar fraction={0.2} phase={null} />);
    expect(bare.querySelector('.progress-bar__phase')).toBeNull();
    expect(bare.querySelector('.progress-bar__status')).toBeNull();
  });
});

describe('sparkRange', () => {
  it('uses a fixed range when given, widening a degenerate one', () => {
    expect(sparkRange([], [0, 1])).toEqual({ lo: 0, hi: 1 });
    expect(sparkRange([], [2, 2])).toEqual({ lo: 2, hi: 3 });
  });

  it('runs from min(0, lowest) to the 98th percentile of finite values', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    values.push(NaN, Infinity);
    const { lo, hi } = sparkRange([{ values, color: 'red' }]);
    expect(lo).toBe(0);
    // 100 finite values sorted: index floor(0.98 * 99) = 97 -> 98
    expect(hi).toBe(98);
    expect(sparkRange([{ values: [-5, 1, 2], color: 'red' }]).lo).toBe(-5);
  });

  it('falls back to lo + 1 with no data or a flat series', () => {
    expect(sparkRange([])).toEqual({ lo: 0, hi: 1 });
    expect(sparkRange([{ values: [0, 0], color: 'red' }])).toEqual({ lo: 0, hi: 1 });
    expect(sparkRange([{ values: [NaN], color: 'red' }])).toEqual({ lo: 0, hi: 1 });
  });
});

describe('sparkPath', () => {
  it('scales into the box and breaks the pen at non-finite values', () => {
    const d = sparkPath([0, 1, 2, 3], [0, 1, NaN, 1], 3, 0, 1, 150, 30);
    expect(d).toBe('M0.0,29.0L50.0,1.0M150.0,1.0');
  });

  it('puts everything at x=0 when x1 is 0 and clamps above hi', () => {
    expect(sparkPath([0], [5], 0, 0, 1, 100, 10)).toBe('M0.0,1.0');
  });

  it('generalises to w and h', () => {
    expect(sparkPath([0, 2], [0, 1], 2, 0, 1, 20, 10)).toBe('M0.0,9.0L20.0,1.0');
  });
});

describe('MetricTile', () => {
  it('renders title, value, hint and a plot only when lines are given', () => {
    const host = mount(() => (
      <MetricTile
        title="Cells"
        value="12"
        hint="how many"
        testid="tile"
        x={[0, 1]}
        lines={[{ values: [1, 2], color: 'red', dash: '3 2' }]}
      />
    ));
    const tile = host.querySelector('.metric-tile')!;
    expect(tile.getAttribute('title')).toBe('how many');
    expect(tile.getAttribute('data-testid')).toBe('tile');
    expect(host.querySelector('.metric-tile__title')!.textContent).toBe('Cells');
    expect(host.querySelector('.metric-tile__value')!.textContent).toBe('12');
    const svg = host.querySelector('svg')!;
    expect(svg.getAttribute('viewBox')).toBe('0 0 150 30');
    expect(svg.querySelectorAll('path')).toHaveLength(1);
    expect(svg.querySelector('path')!.getAttribute('stroke-dasharray')).toBe('3 2');
    dispose?.();
    document.body.replaceChildren();
    const bare = mount(() => <MetricTile title="T" value="v" />);
    expect(bare.querySelector('svg')).toBeNull();
  });
});
