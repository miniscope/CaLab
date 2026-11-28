import { describe, it, expect, afterEach } from 'vitest';
import { render } from 'solid-js/web';
import { createSignal, type JSX } from 'solid-js';
import { assertRange, rangePosition } from '../range.ts';
import { Meter, MeterRow } from '../Meter.tsx';
import { Sparkline } from '../Sparkline.tsx';
import { SegmentedBar } from '../SegmentedBar.tsx';
import { RangeBar } from '../RangeBar.tsx';
import { Legend } from '../Legend.tsx';
import { Badge } from '../Badge.tsx';
import { Icon, ICON_NAMES } from '../Icon.tsx';
import { StageTrack, stageFill, type StageSegment } from '../StageTrack.tsx';
import { MetricTile } from '../MetricTile.tsx';
import { OKABE_ITO } from '../palette.ts';
import { OKABE_ITO as CHART_OKABE_ITO } from '../chart/series-utils.ts';

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
});

function mount(fn: () => JSX.Element): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  dispose = render(fn, host);
  return host;
}

const q = <T extends Element = HTMLElement>(host: Element, sel: string) =>
  host.querySelector<T>(sel)!;

describe('range contract', () => {
  it('maps a value onto the declared range and names the clamped end', () => {
    expect(rangePosition(5, { min: 0, max: 10 })).toEqual({ t: 0.5, clamped: null });
    expect(rangePosition(-3, { min: 0, max: 10 })).toEqual({ t: 0, clamped: 'under' });
    expect(rangePosition(1e9, { min: 0, max: 10 })).toEqual({ t: 1, clamped: 'over' });
    expect(rangePosition(10, { min: 0, max: 10 })).toEqual({ t: 1, clamped: null });
  });

  it('returns null for missing or non-finite values', () => {
    for (const v of [null, undefined, NaN, Infinity, -Infinity]) {
      expect(rangePosition(v, { min: 0, max: 1 })).toBeNull();
    }
  });

  it('maps a log range by decades and clamps non-positive values under', () => {
    const r = { min: 10, max: 1000, scale: 'log' as const };
    expect(rangePosition(100, r)!.t).toBeCloseTo(0.5, 12);
    expect(rangePosition(0, r)).toEqual({ t: 0, clamped: 'under' });
    expect(rangePosition(-5, r)).toEqual({ t: 0, clamped: 'under' });
  });

  it('rejects ranges that are not declared properly', () => {
    expect(() => assertRange({ min: 1, max: 1 })).toThrow(RangeError);
    expect(() => assertRange({ min: 2, max: 1 })).toThrow(RangeError);
    expect(() => assertRange({ min: NaN, max: 1 })).toThrow(RangeError);
    expect(() => assertRange({ min: 0, max: 100, scale: 'log' })).toThrow(RangeError);
    expect(() => assertRange({ min: 0, max: 1 })).not.toThrow();
  });
});

describe('Meter', () => {
  it('is a named meter with min, max, now and valuetext', () => {
    const host = mount(() => (
      <Meter value={3} min={0} max={9} label="Workers busy" format={(v) => `${v} of 9`} />
    ));
    const m = q(host, '[role="meter"]');
    expect(m.getAttribute('aria-label')).toBe('Workers busy');
    expect(m.getAttribute('aria-valuemin')).toBe('0');
    expect(m.getAttribute('aria-valuemax')).toBe('9');
    expect(m.getAttribute('aria-valuenow')).toBe('3');
    expect(m.getAttribute('aria-valuetext')).toBe('3 of 9');
    expect(q(host, '.meter__fill').style.width).toBe('33.333%');
  });

  it('never rescales: a value past either end fills to that end and is flagged', () => {
    const [v, setV] = createSignal<number>(50);
    const host = mount(() => <Meter value={v()} min={0} max={100} target={80} label="x" />);
    const m = q(host, '[role="meter"]');
    const tick = () => q(host, '.meter__tick').style.left;
    expect(tick()).toBe('80%');
    expect(m.dataset.clamped).toBeUndefined();

    setV(1e6);
    expect(q(host, '.meter__fill').style.width).toBe('100%');
    expect(m.dataset.clamped).toBe('over');
    expect(m.getAttribute('aria-valuenow')).toBe('100');
    expect(m.getAttribute('aria-valuetext')).toBe('1000000');
    expect(tick()).toBe('80%');

    setV(-20);
    expect(q(host, '.meter__fill').style.width).toBe('0%');
    expect(m.dataset.clamped).toBe('under');
    expect(m.getAttribute('aria-valuenow')).toBe('0');
    expect(tick()).toBe('80%');
  });

  it('draws "not measured" for a missing value: no fill, no valuenow', () => {
    const host = mount(() => <Meter value={NaN} min={0} max={1} label="Lag" />);
    const m = q(host, '[role="meter"]');
    expect(m.classList.contains('meter--empty')).toBe(true);
    expect(m.hasAttribute('aria-valuenow')).toBe(false);
    expect(m.getAttribute('aria-valuetext')).toBe('not measured');
    expect(host.querySelector('.meter__fill')).toBeNull();
  });

  it('places the band and log ticks on the declared range only', () => {
    const host = mount(() => (
      <Meter
        value={100}
        min={10}
        max={1000}
        scale="log"
        target={1000}
        band={[0.1, 100]}
        label="Speed"
      />
    ));
    expect(q(host, '.meter__fill').style.width).toBe('50%');
    expect(q(host, '.meter__tick').style.left).toBe('100%');
    const band = q(host, '.meter__band');
    expect(band.style.left).toBe('0%');
    expect(band.style.width).toBe('50%');
  });

  it('draws secondary marks on the declared range, clamped, beside the target tick', () => {
    const host = mount(() => (
      <Meter
        value={50}
        min={10}
        max={1000}
        scale="log"
        target={100}
        marks={[10, 1e6, NaN]}
        label="Speed"
      />
    ));
    const marks = Array.from(host.querySelectorAll<HTMLElement>('.meter__mark'));
    expect(marks.map((m) => m.style.left)).toEqual(['0%', '100%']);
    expect(q(host, '.meter__tick').style.left).toBe('50%');
  });

  it('colours the fill by tone through a token', () => {
    const host = mount(() => <Meter value={1} min={0} max={2} label="x" tone="settle" />);
    expect(q(host, '.meter').style.getPropertyValue('--meter-color')).toBe('var(--stage-settle)');
  });
});

describe('MeterRow', () => {
  it('shows the label, meter and figure with unit', () => {
    const host = mount(() => (
      <MeterRow label="Look-back re-read" value={187} min={0} max={1000} unit="fr" />
    ));
    expect(q(host, '.meter-row__label').textContent).toBe('Look-back re-read');
    expect(q(host, '[role="meter"]').getAttribute('aria-label')).toBe('Look-back re-read');
    expect(q(host, '.meter-row__value').textContent).toBe('187 fr');
    expect(q(host, '.meter-row__value').classList.contains('num')).toBe(true);
  });

  it('shows a grey dash when not measured', () => {
    const host = mount(() => <MeterRow label="Lag" value={undefined} min={0} max={10} unit="fr" />);
    expect(q(host, '.meter-row__value').textContent).toBe('–');
    expect(host.querySelector('.meter-row__dash')).not.toBeNull();
  });
});

describe('Sparkline', () => {
  const yOf = (d: string) =>
    d
      .split(/[ML]/)
      .filter(Boolean)
      .map((p) => Number(p.split(',')[1]));

  it('places each point by its own value on the declared range: a spike moves nothing else', () => {
    const [vals, setVals] = createSignal([0, 5, 10]);
    const host = mount(() => (
      <Sparkline values={vals()} range={[0, 10]} width={100} height={24} label="Cells" />
    ));
    const path = () => q(host, '.sparkline__line').getAttribute('d')!;
    expect(yOf(path())).toEqual([22, 12, 2]);
    setVals([0, 5, 1000]);
    expect(yOf(path())).toEqual([22, 12, 2]);
    setVals([-50, 5, 10]);
    expect(yOf(path())).toEqual([22, 12, 2]);
  });

  it('breaks at gaps, dots the last finite point and names it', () => {
    const host = mount(() => (
      <Sparkline values={[1, NaN, 3, NaN]} range={[0, 4]} width={30} height={24} label="Cells" />
    ));
    expect(q(host, '.sparkline__line').getAttribute('d')).toBe('M0.0,17.0M20.0,7.0');
    const dot = q(host, '.sparkline__dot');
    expect(dot.getAttribute('cx')).toBe('20');
    expect(q(host, 'svg').getAttribute('aria-label')).toBe('Cells: 3');
  });

  it('names an all-missing series as not measured and draws no dot', () => {
    const host = mount(() => <Sparkline values={[NaN]} range={[0, 1]} label="Cells" />);
    expect(host.querySelector('.sparkline__dot')).toBeNull();
    expect(q(host, 'svg').getAttribute('aria-label')).toBe('Cells: not measured');
  });
});

describe('SegmentedBar', () => {
  it('sizes parts by value / declared total, skips zeros and leaves the rest as track', () => {
    const host = mount(() => (
      <SegmentedBar
        label="QC"
        total={400}
        parts={[
          { id: 'pass', label: 'Pass', value: 300, color: 'var(--status-ok)' },
          { id: 'warn', label: 'Warning', value: 0, color: 'var(--status-warning)' },
          { id: 'fail', label: 'Fail', value: 50, color: 'var(--status-critical)' },
        ]}
      />
    ));
    const parts = Array.from(host.querySelectorAll<HTMLElement>('.segmented-bar__part'));
    expect(parts.map((p) => p.dataset.part)).toEqual(['pass', 'fail']);
    expect(parts.map((p) => p.style.width)).toEqual(['75%', '12.5%']);
    const bar = q(host, '[role="img"]');
    expect(bar.dataset.clamped).toBeUndefined();
    expect(bar.getAttribute('aria-label')).toBe('QC: Pass 300, Warning 0, Fail 50 of 400');
  });

  it('cuts parts past the declared total and flags the bar', () => {
    const host = mount(() => (
      <SegmentedBar
        label="x"
        total={10}
        parts={[
          { id: 'a', label: 'A', value: 8, color: 'red' },
          { id: 'b', label: 'B', value: 8, color: 'blue' },
        ]}
      />
    ));
    const widths = Array.from(host.querySelectorAll<HTMLElement>('.segmented-bar__part')).map(
      (p) => p.style.width,
    );
    expect(widths).toEqual(['80%', '20%']);
    expect(q(host, '.segmented-bar').dataset.clamped).toBe('over');
  });
});

describe('RangeBar', () => {
  it('positions span, mark and reference on the declared domain only', () => {
    const host = mount(() => (
      <RangeBar lo={10} hi={30} mark={20} reference={50} min={0} max={100} label="Frame time" />
    ));
    const span = q(host, '.range-bar__span');
    expect(span.style.left).toBe('10%');
    expect(span.style.width).toBe('20%');
    expect(q(host, '.range-bar__mark').style.left).toBe('20%');
    expect(q(host, '.range-bar__ref').style.left).toBe('50%');
    expect(q(host, '.range-bar').getAttribute('aria-label')).toBe(
      'Frame time: 10 to 30, mark 20, reference 50',
    );
  });

  it('clamps ends outside the domain and names the side', () => {
    const host = mount(() => <RangeBar lo={-5} hi={500} min={0} max={100} label="x" />);
    const bar = q(host, '.range-bar');
    expect(bar.dataset.clamped).toBe('both');
    expect(q(host, '.range-bar__span').style.width).toBe('100%');
  });

  it('draws no span when an end is not measured', () => {
    const host = mount(() => <RangeBar lo={1} hi={NaN} min={0} max={10} label="x" />);
    expect(host.querySelector('.range-bar__span')).toBeNull();
    expect(q(host, '.range-bar').getAttribute('aria-label')).toBe('x: 1 to not measured');
  });
});

describe('StageTrack', () => {
  const stages = (over: Partial<Record<string, Partial<StageSegment>>> = {}): StageSegment[] => [
    {
      id: 'discover',
      label: 'Discover',
      hue: 'discover',
      weight: 6,
      state: 'running',
      fraction: 0.5,
      ...over.discover,
    },
    {
      id: 'settle',
      label: 'Final settle',
      hue: 'settle',
      weight: 2,
      state: 'waiting',
      ...over.settle,
    },
    { id: 'extract', label: 'Extract', hue: 'extract', weight: 2, state: 'off', ...over.extract },
  ];

  it('sizes segments by weight and fills by state', () => {
    const host = mount(() => <StageTrack stages={stages()} testid="run-track" />);
    const segs = Array.from(host.querySelectorAll<HTMLElement>('.stage-track__seg'));
    expect(segs.map((s) => s.style.flexGrow)).toEqual(['0.6', '0.2', '0.2']);
    expect(segs.map((s) => s.dataset.state)).toEqual(['running', 'waiting', 'off']);
    expect(segs.map((s) => s.style.getPropertyValue('--stage-fill'))).toEqual(['50%', '0%', '0%']);
    expect(segs[0].getAttribute('aria-valuenow')).toBe('50');
    expect(segs[0].getAttribute('aria-label')).toBe('Discover: running');
    expect(segs[2].hasAttribute('aria-valuenow')).toBe(false);
    expect(segs[0].dataset.testid).toBe('run-track-discover');
    expect(segs[0].style.getPropertyValue('--stage-color')).toBe('var(--stage-discover)');
    expect(q(host, '.stage-track').getAttribute('role')).toBe('group');
  });

  it('marks a done stage with its full hue and a check, an error with a cross', () => {
    const host = mount(() => (
      <StageTrack stages={stages({ discover: { state: 'done' }, settle: { state: 'error' } })} />
    ));
    const [d, s] = Array.from(host.querySelectorAll<HTMLElement>('.stage-track__seg'));
    expect(d.style.getPropertyValue('--stage-fill')).toBe('100%');
    expect(d.querySelector('.icon--check')).not.toBeNull();
    expect(d.getAttribute('aria-label')).toBe('Discover: done');
    expect(s.querySelector('.icon--cross')).not.toBeNull();
  });

  it('is no progress bar when off or without a known end', () => {
    const host = mount(() => (
      <StageTrack stages={stages({ discover: { fraction: null, label: 'Discover · live' } })} />
    ));
    const [d, , e] = Array.from(host.querySelectorAll<HTMLElement>('.stage-track__seg'));
    expect(host.querySelectorAll('[role="progressbar"]')).toHaveLength(1);
    expect(d.getAttribute('role')).toBe('img');
    expect(d.hasAttribute('aria-valuenow')).toBe(false);
    expect(d.getAttribute('aria-label')).toBe('Discover · live: running');
    expect(e.getAttribute('role')).toBe('img');
  });

  it('draws a hatched lead-in of the given share, clamped to half the segment', () => {
    const host = mount(() => (
      <StageTrack stages={stages({ discover: { leadIn: 0.1 }, settle: { leadIn: 3 } })} />
    ));
    const leads = Array.from(host.querySelectorAll<HTMLElement>('.stage-track__lead'));
    expect(leads.map((l) => l.style.width)).toEqual(['10%', '50%']);
    expect(host.querySelectorAll('.stage-track__seg')[2].querySelector('.stage-track__lead')).toBe(
      null,
    );
  });

  it('clamps the running fraction to [0, 1]', () => {
    expect(stageFill({ state: 'running', fraction: 1.7 })).toBe(1);
    expect(stageFill({ state: 'running', fraction: -1 })).toBe(0);
    expect(stageFill({ state: 'running', fraction: NaN })).toBe(0);
    expect(stageFill({ state: 'waiting', fraction: 0.9 })).toBe(0);
    expect(stageFill({ state: 'done' })).toBe(1);
  });

  it('takes explicit colours for an app with its own stages', () => {
    const host = mount(() => (
      <StageTrack
        stages={[
          {
            id: 'iter',
            label: 'Iteration 3',
            hue: { color: 'var(--accent)', tint: 'var(--accent-muted)', ink: 'var(--ink-on-fill)' },
            weight: 1,
            state: 'running',
            fraction: 0.25,
          },
        ]}
      />
    ));
    expect(q(host, '.stage-track__seg').style.getPropertyValue('--stage-color')).toBe(
      'var(--accent)',
    );
  });
});

describe('Legend', () => {
  it('renders each swatch as its mark and the label in the text ink', () => {
    const host = mount(() => (
      <Legend
        label="Work by kind"
        items={[
          { label: 'Find cells', color: 'var(--stage-discover)' },
          { label: 'Settle', color: 'var(--stage-settle)', hatched: true },
          { label: 'Target', color: 'var(--ink-1)', mark: 'line', dashed: true, value: '30 fps' },
        ]}
      />
    ));
    const items = Array.from(host.querySelectorAll('.legend__item'));
    expect(items.map((i) => i.querySelector('.legend__label')!.textContent)).toEqual([
      'Find cells',
      'Settle',
      'Target',
    ]);
    expect(items[1].querySelector('.legend__mark--hatched')).not.toBeNull();
    expect(items[2].querySelector('.legend__mark--line.legend__mark--dashed')).not.toBeNull();
    expect(items[2].querySelector('.legend__value')!.textContent).toBe('30 fps');
    expect(q(host, 'ul').getAttribute('aria-label')).toBe('Work by kind');
  });
});

describe('Badge', () => {
  it('always gives a status tone its icon', () => {
    const host = mount(() => (
      <>
        <Badge tone="ok">pass</Badge>
        <Badge tone="warning">check</Badge>
        <Badge tone="critical">fail</Badge>
      </>
    ));
    const icons = Array.from(host.querySelectorAll('.badge')).map((b) =>
      Array.from(b.querySelector('.icon')!.classList).find((c) => c.startsWith('icon--'))!,
    );
    expect(icons).toEqual(['icon--check', 'icon--warning', 'icon--cross']);
  });

  it('gives a stage tone a hue dot and no icon, neutral neither', () => {
    const host = mount(() => (
      <>
        <Badge tone="discover">running</Badge>
        <Badge>v7</Badge>
      </>
    ));
    const [stage, neutral] = Array.from(host.querySelectorAll('.badge'));
    expect(stage.querySelector('.badge__dot')).not.toBeNull();
    expect(stage.querySelector('.icon')).toBeNull();
    expect(neutral.querySelector('.badge__dot, .icon')).toBeNull();
    expect(neutral.textContent).toBe('v7');
  });
});

describe('Icon', () => {
  it('is decorative without a label and an image with one', () => {
    const host = mount(() => (
      <>
        <Icon name="pause" />
        <Icon name="gpu" label="GPU" size={14} />
      </>
    ));
    const [a, b] = Array.from(host.querySelectorAll('svg'));
    expect(a.getAttribute('aria-hidden')).toBe('true');
    expect(a.hasAttribute('role')).toBe(false);
    expect(b.getAttribute('role')).toBe('img');
    expect(b.getAttribute('aria-label')).toBe('GPU');
    expect(b.getAttribute('width')).toBe('14');
  });

  it('draws every glyph of the set', () => {
    const host = mount(() => (
      <>
        {ICON_NAMES.map((n) => (
          <Icon name={n} />
        ))}
      </>
    ));
    for (const svg of Array.from(host.querySelectorAll('svg'))) {
      expect(svg.querySelectorAll('path').length).toBeGreaterThan(0);
    }
    expect(ICON_NAMES).toEqual(
      expect.arrayContaining(['pause', 'play', 'stop', 'restart', 'check', 'cross', 'info', 'gpu']),
    );
  });
});

describe('MetricTile extensions', () => {
  it('renders the same DOM as before when status and meter are absent', () => {
    const plain = mount(() => <MetricTile title="Cells" value="298" testid="t" />).innerHTML;
    dispose?.();
    document.body.replaceChildren();
    const withUndefined = mount(() => (
      <MetricTile title="Cells" value="298" testid="t" status={undefined} meter={undefined} />
    )).innerHTML;
    expect(withUndefined).toBe(plain);
    expect(plain).toBe(
      '<div class="metric-tile" data-testid="t"><div class="metric-tile__head">' +
        '<span class="metric-tile__title">Cells</span><span class="metric-tile__value">298</span>' +
        '</div></div>',
    );
  });

  it('shows a labelled status dot and a meter slot', () => {
    const host = mount(() => (
      <MetricTile
        title="Cells"
        value="298"
        status={{ tone: 'warning', label: 'still changing' }}
        meter={<Meter value={6.5} min={0} max={9} label="Workers busy" />}
      />
    ));
    const dot = q(host, '.metric-tile__status');
    expect(dot.classList.contains('metric-tile__status--warning')).toBe(true);
    expect(dot.getAttribute('aria-label')).toBe('still changing');
    expect(q(host, '.metric-tile__meter [role="meter"]')).not.toBeNull();
  });
});

describe('Okabe-Ito', () => {
  it('has one definition, re-exported by the chart module', () => {
    expect(CHART_OKABE_ITO).toBe(OKABE_ITO);
  });
});
