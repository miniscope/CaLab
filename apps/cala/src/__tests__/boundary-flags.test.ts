import { describe, expect, it } from 'vitest';
import {
  alignmentChecks,
  BOUNDARY_FLAG_RULES as R,
  boundaryFlagJson,
  BoundaryMonitor,
  changeChecks,
  countZ,
  median,
  outcomeChecks,
  parseBoundaryFlag,
  robustSd,
  robustZ,
  SEPARATE_SUGGESTION,
  shareZ,
  summarize,
  traceSigma,
  type WindowStats,
} from '../lib/boundary-flags.ts';
import type { SessionStart } from '../lib/session-boundary.ts';
import { sessionStart } from '../lib/session-boundary.ts';
import { exportSessionBlock, runManifest, sessionMetadata } from '../lib/session-export.ts';
import { emptyIndex, findRuns, mergeRuns, sessionStatus } from '../lib/project-index.ts';

const start = (o: Partial<SessionStart> = {}): SessionStart => ({
  index: 1,
  frame: 1000,
  transform: [0, 0, 0],
  fitted: [0.05, 0.8, -0.4],
  ncc: 0.95,
  nccUnrotated: 0.95,
  chanceNcc: 0.3,
  pinnedRotation: false,
  pinnedShift: false,
  floorGain: 1.0,
  floorOffset: 0,
  floorKept: 0.98,
  noiseRatio: 1.0,
  ...o,
});

/** A within-session null around `c` with spread about `sd`. */
const nul = (c: number, sd: number, n = 12) =>
  Array.from({ length: n }, (_, i) => c + sd * (((i * 7) % n) / (n - 1) - 0.5) * 2.7);

const win = (o: Partial<WindowStats> = {}): WindowStats => ({
  start: 0,
  frames: 600,
  adds: 20,
  noiseDrift: 0,
  floorDrift: 0,
  active: 100,
  silenced: 10,
  ...o,
});

describe('statistics', () => {
  it('median, robust SD and robust z', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNaN();
    expect(robustSd([1, 2, 3, 4, 5])).toBeCloseTo(1.4826, 4);
    expect(robustZ(10, [1, 2, 3, 4, 5], 3)).toBeCloseTo(7 / 1.4826, 4);
    expect(robustZ(10, [1, 2], 3)).toBeNaN();
    expect(robustZ(2, [2, 2, 2], 3)).toBe(0);
    expect(robustZ(3, [2, 2, 2], 3)).toBe(Infinity);
  });

  it('counts: a Poisson-like excess, damped by the null overdispersion', () => {
    expect(countZ(20, [20, 20, 20])).toBeCloseTo(0, 6);
    const z = countZ(66, [20, 22, 18, 21]);
    expect(z).toBeGreaterThan(R.outsideZ);
    // The same count against a bursty null is less surprising.
    expect(countZ(66, [5, 40, 10, 30])).toBeLessThan(z);
    expect(countZ(3, [])).toBeNaN();
    // A null of zeros still gives a finite z.
    expect(Number.isFinite(countZ(5, [0, 0, 0]))).toBe(true);
  });

  it('shares: excess over the pooled share', () => {
    const n = [
      { s: 10, a: 100 },
      { s: 12, a: 100 },
      { s: 8, a: 100 },
    ];
    expect(Math.abs(shareZ(10, 100, n))).toBeLessThan(1);
    expect(shareZ(60, 100, n)).toBeGreaterThan(R.outsideZ);
    expect(shareZ(1, 0, n)).toBeNaN();
  });

  it('trace noise from first differences off the clip at 0', () => {
    const x = Array.from({ length: 400 }, (_, i) => 10 + (i % 2 ? 1 : -1));
    expect(traceSigma(x)).toBeCloseTo((1.4826 * 2) / Math.SQRT2, 6);
    expect(traceSigma(new Array(400).fill(0))).toBeNaN();
  });
});

describe('alignment checks', () => {
  const N = nul(0.95, 0.004);

  it('ok inside the within-session null', () => {
    const [m] = alignmentChecks({ start: start(), nullNcc: N }, R);
    expect(m.key).toBe('match');
    expect(m.severity).toBe('ok');
    expect(m.judged).toBe(true);
  });

  it('warning outside the null but well above chance', () => {
    const [m] = alignmentChecks({ start: start({ ncc: 0.85 }), nullNcc: N }, R);
    expect(m.severity).toBe('warning');
    expect(m.z).toBeGreaterThan(R.outsideZ);
  });

  it('failed when nearer chance than a within-session match', () => {
    const c = alignmentChecks({ start: start({ ncc: 0.4 }), nullNcc: N }, R);
    expect(c[0].severity).toBe('failed');
    const f = summarize(1, 1000, c);
    expect(f.severity).toBe('failed');
    expect(f.suggestion).toBe(SEPARATE_SUGGESTION);
    expect(f.reason).toMatch(/Alignment failed/);
  });

  it('a pinned fit: warning with a good match, failed with a poor one', () => {
    const ok = alignmentChecks({ start: start({ pinnedShift: true }), nullNcc: N }, R);
    expect(ok.find((c) => c.key === 'search_edge')?.severity).toBe('warning');
    const bad = alignmentChecks(
      { start: start({ ncc: 0.85, pinnedRotation: true, fitted: [3, 0, 0] }), nullNcc: N },
      R,
    );
    expect(bad.find((c) => c.key === 'search_edge')?.severity).toBe('failed');
  });

  it('too few within-session samples: not judged (but chance still fails it)', () => {
    const [m] = alignmentChecks({ start: start({ ncc: 0.9 }), nullNcc: [0.95] }, R);
    expect(m.judged).toBe(false);
    expect(m.severity).toBe('ok');
    const [f] = alignmentChecks({ start: start({ ncc: 0.35 }), nullNcc: [0.95] }, R);
    expect(f.severity).toBe('failed');
  });

  it('a replay record (no fit) is not judged', () => {
    const [m] = alignmentChecks({ start: start({ ncc: undefined }), nullNcc: N }, R);
    expect(m.judged).toBe(false);
  });
});

describe('change and outcome checks', () => {
  const nulWins = [
    win(),
    win({ adds: 22, silenced: 12 }),
    win({ adds: 18, silenced: 8 }),
    win({ adds: 21 }),
  ];
  const input = (after: WindowStats | null, st = start()) => ({
    start: st,
    after,
    cells: 100,
    nul: nulWins.map((w, i) => ({
      ...w,
      noiseDrift: 0.002 * (i - 1.5),
      floorDrift: 0.01 * (i - 1.5),
    })),
    windowS: 30,
  });

  it('the floor fit must follow the majority of the pixels', () => {
    expect(changeChecks(input(null, start({ floorKept: 0.3 })), R)[0].severity).toBe('failed');
    expect(changeChecks(input(null), R)[0].severity).toBe('ok');
    // The identity fallback (no fit) is not a failure.
    expect(changeChecks(input(null, start({ floorKept: 0 })), R)[0].severity).toBe('ok');
  });

  it('waits for the window, then judges noise and floor drift', () => {
    const wait = changeChecks(input(null), R);
    expect(wait.find((c) => c.key === 'noise_drift')?.judged).toBe(false);
    const steady = changeChecks(input(win({ noiseDrift: 0.001 })), R);
    expect(steady.find((c) => c.key === 'noise_drift')?.severity).toBe('ok');
    const drift = changeChecks(input(win({ noiseDrift: 0.2, floorDrift: 2, floorStep: 0 })), R);
    expect(drift.find((c) => c.key === 'noise_drift')?.severity).toBe('warning');
    expect(drift.find((c) => c.key === 'floor_drift')?.severity).toBe('warning');
    // Settling smaller than the step the rescale applied is not a failure to correct.
    const settle = changeChecks(
      input(
        win({ noiseDrift: 0.02, floorDrift: 0.2, floorStep: -0.3 }),
        start({ noiseRatio: 1.25 }),
      ),
      R,
    );
    expect(settle.find((c) => c.key === 'noise_drift')?.severity).toBe('ok');
    expect(settle.find((c) => c.key === 'floor_drift')?.severity).toBe('ok');
  });

  it('new cells: ok, warning, failed (more than half the library)', () => {
    const sev = (adds: number) =>
      outcomeChecks(input(win({ adds })), R).find((c) => c.key === 'new_cells')?.severity;
    expect(sev(23)).toBe('ok');
    expect(sev(66)).toBe('warning');
    expect(sev(150)).toBe('failed');
  });

  it('silent cells: ok, warning, failed (more than half the active cells)', () => {
    const sev = (silenced: number) =>
      outcomeChecks(input(win({ silenced })), R).find((c) => c.key === 'silent_cells')?.severity;
    expect(sev(11)).toBe('ok');
    expect(sev(40)).toBe('warning');
    expect(sev(80)).toBe('failed');
  });

  it('too few within-session windows: not judged', () => {
    const c = outcomeChecks({ ...input(win({ adds: 500 })), nul: nulWins.slice(0, 2) }, R);
    expect(c.every((x) => !x.judged && x.severity === 'ok')).toBe(true);
  });
});

describe('BoundaryMonitor', () => {
  const fps = 20;
  const W = R.windowS * fps; // 600 frames
  const B = 6 * W; // session 1 starts after six windows
  const T = B + 3 * W;
  const nCells = 40;

  /** Cell k fires every 50 frames (phase k); `silentAfter`: cells < it stop after B. */
  function trace(k: number, f: number, silentAfter: number): number {
    if (f >= B && k < silentAfter) return 0.5 + 0.1 * Math.sin(f * 1.3 + k);
    const base = 1 + 0.1 * Math.sin(f * 1.7 + k * 0.9);
    return (f + k * 7) % 50 < 3 ? base + 10 : base;
  }

  function run(
    o: { silentAfter?: number; addsAfter?: number; ncc?: number; stopAt?: number } = {},
  ) {
    const m = new BoundaryMonitor({ boundaries: [B], frames: T, fps });
    const ids = Uint32Array.from({ length: nCells }, (_, k) => k + 1);
    let adds = 0;
    const stop = o.stopAt ?? T;
    const seen: string[] = [];
    for (let f = 0; f < stop; f += 8) {
      const count = Math.min(8, T - f);
      if (f === B) m.onSessionStart(start({ frame: B, ncc: o.ncc ?? 0.95 }));
      if (f % 104 === 96 && f < B) m.onNull(f + count, 0.95 + 0.002 * Math.sin(f));
      if (f % 32 === 0) m.onImaging(f, 2 + 0.001 * Math.sin(f / 100), 0.1);
      // 20 adds per window within the session, `addsAfter` in the window after B.
      const rate = f >= B && f < B + W ? (o.addsAfter ?? 20) / W : 20 / W;
      adds += rate * count;
      m.onAdds(f + count, Math.floor(adds));
      const tr = new Float32Array(count * nCells);
      for (let i = 0; i < count; i++)
        for (let k = 0; k < nCells; k++) tr[i * nCells + k] = trace(k, f + i, o.silentAfter ?? 0);
      m.onTraces(f, count, ids, tr);
      if (m.changed()) {
        const fl = m.flags()[0];
        if (fl) seen.push(`${fl.severity}${fl.pending ? '?' : ''}`);
      }
    }
    return { m, seen };
  }

  it('a quiet boundary: pending at first, then ok', () => {
    const { m, seen } = run();
    expect(seen[0]).toBe('ok?');
    const f = m.flags()[0];
    expect(f.severity).toBe('ok');
    expect(f.pending).toBe(false);
    expect(f.checks.find((c) => c.key === 'new_cells')?.judged).toBe(true);
    expect(f.checks.find((c) => c.key === 'silent_cells')?.judged).toBe(true);
    expect(f.checks.find((c) => c.key === 'match')?.judged).toBe(true);
  });

  it('cells going silent at once and a burst of adds flag the boundary', () => {
    const f = run({ silentAfter: 30, addsAfter: 70 }).m.flags()[0];
    expect(f.severity).toBe('failed');
    expect(f.checks.find((c) => c.key === 'silent_cells')?.severity).toBe('failed');
    // 70 adds against 20 per window: an excess of 50, more than half the 40-cell library.
    expect(f.checks.find((c) => c.key === 'new_cells')?.severity).toBe('failed');
    expect(f.suggestion).toBe(SEPARATE_SUGGESTION);
  });

  it('a run that ends before the window played: not judged, not pending', () => {
    const { m } = run({ stopAt: B + 100 });
    m.end();
    const f = m.flags()[0];
    expect(f.pending).toBe(false);
    expect(f.checks.find((c) => c.key === 'new_cells')?.judged).toBe(false);
  });
});

describe('persistence', () => {
  const flag = summarize(
    1,
    1000,
    alignmentChecks({ start: start({ ncc: 0.4 }), nullNcc: nul(0.95, 0.004) }, R),
  );

  it('round-trips through its JSON form', () => {
    const back = parseBoundaryFlag(JSON.parse(JSON.stringify(boundaryFlagJson(flag))));
    expect(back?.severity).toBe('failed');
    expect(back?.reason).toBe(flag.reason);
    expect(back?.suggestion).toBe(SEPARATE_SUGGESTION);
    expect(back?.checks[0].key).toBe('match');
    expect(back?.checks[0].value).toBeCloseTo(0.4, 6);
    expect(parseBoundaryFlag({ severity: 'bad' })).toBeNull();
    expect(parseBoundaryFlag(null)).toBeNull();
  });

  it('goes into the export block, cala-session.json, the run manifest and the index', () => {
    const rec = {
      index: 1,
      name: 's2',
      dir: 'mouse1/s2',
      resultsPath: 's2',
      startFrame: 1000,
      frames: 1000,
      fps: 20,
      recordingStartMs: null,
      status: 'written' as const,
      boundary: flag,
    };
    expect((exportSessionBlock(rec, 'joint', 2).boundary as { severity: string }).severity).toBe(
      'failed',
    );
    const settings = { mode: 'joint' as const, refineRuns: 1 };
    const meta = sessionMetadata({
      version: 'dev',
      settings,
      session: rec,
      sessions: 2,
      boundaries: [1000],
      stages: [],
      libraryVersion: 3,
      cells: 2,
      sharedCellIds: [1, 2],
      createdAt: '2026-11-13T00:00:00.000Z',
    });
    expect((meta.boundary as { severity: string }).severity).toBe('failed');
    const manifest = runManifest({
      version: 'dev',
      settings,
      sessions: [
        { ...rec, index: 0, name: 's1', dir: 'mouse1/s1', resultsPath: 's1', boundary: undefined },
        rec,
      ],
      boundaries: [1000],
      root: 'runs/r1',
      createdAt: '2026-11-13T00:00:00.000Z',
      updatedAt: '2026-11-13T00:00:00.000Z',
      finished: true,
    });
    const sessions = manifest.sessions as Record<string, unknown>[];
    expect(sessions[0].boundary).toBeUndefined();
    expect((sessions[1].boundary as { severity: string }).severity).toBe('failed');
    // Rebuilt from the run folder, the session table reads it back.
    const files = [
      { path: 'runs/r1/cala-run.json', text: JSON.stringify(manifest) },
      { path: 'runs/r1/s2/cala-session.json', text: JSON.stringify(meta) },
    ];
    const idx = mergeRuns(
      emptyIndex('mouse1', { kind: 'default', label: 'x' }, new Date(0)),
      findRuns(files).runs,
    ).index;
    const sid = idx.runs[0].sessions[1].id;
    const st = sessionStatus(idx, sid);
    expect(st.boundary?.severity).toBe('failed');
    expect(st.runMode).toBe('joint');
    expect(st.runSessions).toHaveLength(2);
  });
});

describe('sessionStart reads the flag inputs from the aligner', () => {
  it('chance level and pinned edges', () => {
    const st = sessionStart(
      { session: { index: 1, frame: 10 }, sessionAlign: [0, 0, 0, 3, 1, 2, 0.5, 0.4, 0.3, 1, 0] },
      [0, 0, 0],
      [1, 0, 0.9, 1],
    );
    expect(st.chanceNcc).toBeCloseTo(0.3, 6);
    expect(st.pinnedRotation).toBe(true);
    expect(st.pinnedShift).toBe(false);
  });
});
