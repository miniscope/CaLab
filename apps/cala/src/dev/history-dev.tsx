/* Dev-only page: renders HistoryPlot / WholeRunStrip on a synthetic 5-day feed.
   Served by `npx vite --port 5198` at /history-dev.html. Not part of the build
   (vite builds index.html only). Draw times: window.__historyDrawMs. */
import { render } from 'solid-js/web';
import { createSignal } from 'solid-js';
import { StreamHistory, type SeriesSpec } from '@calab/compute';
import { HistoryPlot, WholeRunStrip, createTimeWindow, type HistoryEvent } from '@calab/ui/chart';
import '@calab/ui/styles/base.css';
import '@calab/ui/styles/app-global.css';
import '../styles/global.css';

const DAY = 86400;
const RUN = 5 * DAY;
const OI = {
  orange: '#e69f00',
  sky: '#56b4e9',
  green: '#009e73',
  blue: '#0072b2',
  verm: '#d55e00',
  purple: '#cc79a7',
};

function spec(
  key: string,
  group: string,
  label: string,
  unit: string,
  range: [number, number],
  color: string,
  o: Partial<SeriesSpec> = {},
): SeriesSpec {
  return {
    key,
    label,
    short: o.short ?? label,
    unit,
    group,
    kind: 'value',
    range,
    rangeRule: 'ladder125',
    color,
    digits: 1,
    ...o,
  };
}

const GROUPS: Record<string, SeriesSpec[]> = {
  convergence: [
    spec('cells', 'convergence', 'Cells', 'cells', [0, 200], OI.orange, { digits: 0 }),
    spec('churn', 'convergence', 'Churn', '/min', [0, 10], OI.verm, { kind: 'rate' }),
    spec('stable', 'convergence', 'Stable', '', [0, 1], OI.green, {
      rangeRule: 'fixed',
      digits: 2,
    }),
    spec('explained', 'convergence', 'Explained', '', [0, 1], OI.sky, {
      rangeRule: 'fixed',
      digits: 2,
    }),
    spec('resid', 'convergence', 'Residual', '', [0, 5], OI.purple),
  ],
  scales: [
    spec('diam', 'scales', 'Diameter', 'px', [0, 20], OI.orange, {
      kind: 'band',
      rangeRule: 'double',
    }),
    spec('psf', 'scales', 'PSF', 'px', [0, 4], OI.blue, { kind: 'step' }),
  ],
  imaging: [
    spec('noise', 'imaging', 'Noise', 'grey', [0, 5], OI.orange),
    spec('bg', 'imaging', 'Background', 'grey', [0, 100], OI.sky),
    spec('gain', 'imaging', 'Gain', '%', [-5, 5], OI.green),
    spec('ffchg', 'imaging', 'Flat-field', '%', [0, 5], OI.purple, { kind: 'stem' }),
  ],
  motion: [
    spec('dy', 'motion', 'dy', 'px', [-10, 10], OI.orange),
    spec('dx', 'motion', 'dx', 'px', [-10, 10], OI.blue),
    spec('flag', 'motion', 'Flagged', '%', [0, 100], OI.verm),
  ],
  throughput: [
    spec('fps', 'throughput', 'Rate', 'fps', [0, 120], OI.orange, { digits: 0 }),
    spec('lag', 'throughput', 'Lag', 's', [0, 60], OI.blue),
  ],
};

function noise(i: number, k: number) {
  let n = (i * 374761393 + k * 668265263) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296 - 0.5;
}

const history = new StreamHistory({ baseBinS: 1 });
for (const g of Object.values(GROUPS)) for (const s of g) history.define(s);

const events: HistoryEvent[] = [];
history.onRangeStep = (key, e) =>
  events.push({ t: e.t, kind: 'range', label: `${key}: range ${e.from[1]} to ${e.to[1]}` });

// Coarse synthetic feed (every 20 s of stream time) to keep start-up quick.
const STEP = 20;
for (let t = 0; t < RUN * 0.92; t += STEP) {
  const i = t / STEP;
  const spike = Math.abs(t - (2 * DAY + 3 * 3600)) < 60;
  history.push('cells', t, 180 * (1 - Math.exp(-t / 3600)) + 6 * noise(i, 1));
  history.push(
    'churn',
    t,
    Math.max(0, 6 * Math.exp(-t / 7200) + 2 + 3 * noise(i, 2)) * (STEP / 60),
  );
  history.push('stable', t, Math.min(1, 1 - Math.exp(-t / 5000) + 0.02 * noise(i, 3)));
  history.push('explained', t, Math.min(1, 0.9 * (1 - Math.exp(-t / 1800)) + 0.02 * noise(i, 4)));
  history.push('resid', t, 1.5 + noise(i, 5) * 1.5);
  history.push('diam', t, 12 + noise(i, 6), [11, 13]);
  history.push('psf', t, t < DAY ? 2 : 2.4);
  history.push('noise', t, 2.5 + 0.4 * Math.sin(t / 6000) + 0.2 * noise(i, 7));
  history.push('bg', t, 40 + 10 * Math.sin((t / DAY) * 6.28) + noise(i, 8) * 2);
  history.push('gain', t, 2 * Math.sin(t / 900) + noise(i, 9));
  if (i % 30 === 0) history.push('ffchg', t, Math.abs(noise(i, 10)) * 4);
  history.push('dy', t, spike ? 15 : 2 * Math.sin(t / 300) + noise(i, 11) * 2);
  history.push('dx', t, 1.5 * Math.sin(t / 420) + noise(i, 12) * 2);
  history.push('flag', t, Math.max(0, 5 + 20 * noise(i, 13)));
  history.push('fps', t, 30 + 2 * noise(i, 14));
  history.push('lag', t, Math.max(0, 3 + 2 * noise(i, 15)));
  if (i % 4000 === 0) events.push({ t, kind: 'scale', label: 'scale applied' });
  if (i % 400 === 0) events.push({ t, kind: 'ff', label: 'flat-field map' });
}
history.advance(RUN * 0.92);
events.push({ t: DAY * 3, kind: 'warn', label: 'gap: 12 frames dropped' });
events.push({ t: DAY * 1.2, t1: DAY * 1.2 + 600, kind: 'pause', label: 'paused' });

const win = createTimeWindow();
const [tick] = createSignal(0);
const [sel, setSel] = createSignal<Record<string, string>>({});
const [insp, setInsp] = createSignal<number | null>(null);
const now = () => RUN * 0.92;
const window_ = () => win.resolve(now(), RUN);
const draws: Record<string, number> = {};
(globalThis as unknown as { __historyDrawMs: Record<string, number> }).__historyDrawMs = draws;

function Plot(p: { g: string; height: number; compact?: boolean }) {
  const keys = GROUPS[p.g].map((s) => s.key);
  return (
    <HistoryPlot
      history={() => history}
      keys={keys}
      window={window_}
      now={now}
      runEnd={() => RUN}
      events={() => events}
      tick={tick}
      height={p.height}
      selected={() => sel()[p.g] ?? keys[0]}
      onSelect={(k) => setSel({ ...sel(), [p.g]: k })}
      inspected={insp}
      onInspect={setInsp}
      clockAt={(t) => Date.UTC(2026, 10, 9, 12) + t * 1000}
      onBrush={(a, b) => win.setBrush(a, b)}
      onResetWindow={() => win.setRun()}
      scaleGuides={p.g === 'scales'}
      compact={p.compact}
      label={p.g}
      testid={`plot-${p.g}`}
      onDraw={(ms) => (draws[p.g + (p.compact ? '-compact' : '')] = ms)}
    />
  );
}

render(
  () => (
    <div style={{ width: '1440px', padding: '12px 16px', background: 'var(--bg-secondary)' }}>
      <div
        style={{ width: '600px', background: '#fff', padding: '8px 12px', 'margin-bottom': '8px' }}
      >
        <WholeRunStrip
          history={() => history}
          seriesKey="cells"
          runEnd={() => RUN}
          now={now}
          window={window_}
          tick={tick}
          onBrush={(a, b) => win.setBrush(a, b)}
          onResetWindow={() => win.setRun()}
          testid="strip"
        />
        <Plot g="convergence" height={130} compact />
      </div>
      <div style={{ display: 'grid', 'grid-template-columns': '1fr 1fr', gap: '8px' }}>
        {['convergence', 'scales', 'imaging', 'motion', 'throughput'].map((g) => (
          <div style={{ background: '#fff', padding: '8px 12px' }}>
            <Plot g={g} height={g === 'convergence' || g === 'scales' ? 200 : 120} />
          </div>
        ))}
      </div>
    </div>
  ),
  document.getElementById('root')!,
);
