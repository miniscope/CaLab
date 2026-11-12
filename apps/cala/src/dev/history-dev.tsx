/* Dev-only page: the History views on a synthetic 5-day live run, fed through
   the app's own RunHistory (same series, ranges and events as a real run) but
   without the pipeline. Served by `npx vite --port 5198` at /history-dev.html;
   not part of the build (vite builds index.html only).
   window.__historyDev = { feedMs, bytes, eventBytes, events, levels, drawMs }. */
import { render } from 'solid-js/web';
import '@calab/ui/styles/base.css';
import '@calab/ui/styles/app-global.css';
import '../styles/global.css';
import '../styles/layout.css';
import { createRunHistory } from '../lib/run-history.ts';
import {
  createHistoryUi,
  GroupPlot,
  HistoryExpanded,
  HistoryTab,
  RunStrip,
} from '../components/HistoryPanel.tsx';

const DAY = 86400;
const RUN_S = 5 * DAY;
const FPS = 30;
/** 7 Nov 2026 09:12 local. */
const START = new Date(2026, 10, 7, 9, 12).getTime();

let fakeNow = START;
const run = createRunHistory(() => fakeNow);
const ui = createHistoryUi(run);

/** Deterministic noise in [-1, 1]. */
function noise(i: number, k: number): number {
  const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453;
  return 2 * (x - Math.floor(x)) - 1;
}

const t0 = performance.now();
run.reset({ fps: FPS, live: true });
const dy = new Float32Array(FPS);
const dx = new Float32Array(FPS);
const quality = new Float32Array(FPS);
const flags = new Uint32Array(FPS);
const off = new Float32Array(FPS);
const gain = new Float32Array(FPS);
let dropped = 0;
const spikeS = 2 * DAY + 3 * 3600 + 600;
for (let s = 0; s < RUN_S * 0.92; s++) {
  fakeNow = START + s * 1000 * (1 + 0.001 * noise(s, 1));
  const start = s * FPS;
  const slow = Math.sin((2 * Math.PI * s) / DAY);
  for (let i = 0; i < FPS; i++) {
    const j = start + i;
    dy[i] = 0.5 + 0.4 * noise(j, 2) + 0.3 * slow;
    dx[i] = 0.9 + 0.4 * noise(j, 3);
    quality[i] = 0.8 + 0.05 * noise(j, 4);
    flags[i] = noise(j, 5) > 0.985 ? 32 : 0;
    off[i] = 0.1 * noise(j, 6);
    gain[i] = 0.0007 * noise(j, 7);
  }
  // A motion event on day 2 steps dy's range from ±10 to ±20.
  if (s >= spikeS && s < spikeS + 20) {
    for (let i = 0; i < FPS; i++) {
      dy[i] += 15 * Math.exp(-((s - spikeS - 10) ** 2) / 20);
      dx[i] -= 6 * Math.exp(-((s - spikeS - 10) ** 2) / 20);
    }
  }
  const imaging =
    s % 1 === 0
      ? {
          frame: start + FPS - 1,
          noiseSigma: 2.5 + 0.05 * noise(s, 8) + 0.1 * slow,
          background: 6 - 2e-6 * s,
        }
      : undefined;
  const lag = Math.max(0, 90 + 60 * noise(s, 9));
  run.batch(
    { start, count: FPS, dy, dx, quality, flags, flickerOffset: off, flickerGain: gain, imaging },
    29.9 + 0.3 * noise(s, 10) - (Math.abs(s - 3.4 * DAY) < 120 ? 25 : 0),
    11 + noise(s, 11),
    lag,
  );
  const grow = 1 - Math.exp(-s / 3000);
  run.convergence(
    start + FPS - 1,
    {
      cells: 380 * grow + 20 * Math.sin(s / 20000) + 3 * noise(s, 12),
      explained: 0.84 * grow + 0.01 * noise(s, 13),
      residualExcess: 0.47 + 0.6 * Math.exp(-s / 3000) + 0.03 * noise(s, 14),
      stableFrac: 0.94 * grow + 0.02 * noise(s, 15),
      fpStability: 0.97 * grow,
      snrMedian: 8,
      passFrac: 0.8,
      edits: {
        newAdds: 30 * Math.exp(-s / 2000) + Math.max(0, noise(s, 16)),
        reAdds: Math.max(0, 0.5 * noise(s, 17)),
        churned: Math.max(0, 0.5 * noise(s, 18)),
        establishedRemovals: Math.max(0, 0.3 * noise(s, 19)),
      },
    },
    380 * grow,
  );
  if (noise(s, 20) > 0.99998) dropped += 12;
  run.liveCounters({ frame: start + FPS, dropped, missed: 0, lagMs: 120 + 30 * noise(s, 21) });
  if (s % 60 === 30) {
    run.flatMap(0.05 + 0.04 * Math.abs(noise(s, 22)));
    run.log({ frame: start, kind: 'flatfield', detail: 'Flat-field map', replay: false });
  }
  if (s === Math.round(1.2 * DAY)) run.log({ frame: start, kind: 'pause', detail: 'Paused' });
  if (s === Math.round(1.2 * DAY) + 600)
    run.log({ frame: start, kind: 'resume', detail: 'Resumed' });
  if (s === 3 * DAY)
    run.log({ frame: start, kind: 'warning', detail: 'Slow-loop reservoir 90% full' });
}
const feedMs = performance.now() - t0;
// Inspect d3 14:20 like the mockup.
ui.window.setInspected(3 * DAY + 14 * 3600 + 20 * 60);

const h = run.history();
(globalThis as unknown as { __historyDev: unknown }).__historyDev = {
  feedMs,
  bytes: h.bytes(),
  eventBytes: run.events().bytes(),
  events: run.events().list().length,
  levels: h.levels(),
  drawMs: ui.drawMs,
};

const expanded = new URLSearchParams(location.search).has('expanded');
const card = {
  border: '1px solid var(--border-subtle)',
  'border-radius': '6px',
  background: 'var(--bg-primary)',
  padding: '8px 12px',
};
render(
  () => (
    <div class="cala-main" style={{ height: '100vh', '--cala-fov-w': '820px' }}>
      <div class="cala-main__fov">
        {expanded ? (
          <HistoryExpanded ui={ui} />
        ) : (
          <div
            style={{
              ...card,
              flex: '1',
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'center',
              background: '#111',
              color: '#aaa',
            }}
          >
            Field of view (synthetic 5-day live run, no pipeline: {(feedMs / 1000).toFixed(1)} s to
            feed, {(h.bytes() / 1048576).toFixed(2)} MiB of history,{' '}
            {run.events().list().length.toLocaleString()} events)
          </div>
        )}
      </div>
      <div class="cala-main__side">
        <div style={card}>
          <h2 class="panel-label">Run</h2>
          <RunStrip ui={ui} />
          <GroupPlot ui={ui} group="convergence" height={130} compact />
        </div>
        <div style={{ ...card, flex: '1', 'min-height': '0', display: 'flex' }}>
          <div style={{ flex: '1', 'min-height': '0' }}>
            <HistoryTab ui={ui} minHeight={330} />
          </div>
        </div>
      </div>
    </div>
  ),
  document.getElementById('root')!,
);
