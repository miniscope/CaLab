import { describe, expect, it } from 'vitest';
import { stepViews, type StepInput } from '../lib/step-view.ts';
import {
  aboutLeft,
  formatBytes,
  LEAD_IN_SHARE,
  MIN_SHARE,
  niceCeil,
  RailHistory,
  railKey,
  railLabel,
  railStages,
  runSecondsLeft,
  stageShares,
  trackPosition,
  type RailTrackInput,
} from '../lib/rail-view.ts';

const step: StepInput = {
  live: false,
  discover: 'running',
  processed: 0,
  total: 1000,
  discoverFps: 0,
  lookback: true,
  lookbackRun: true,
  settling: false,
  settleFed: 0,
  settleTotal: 1000,
  settleFps: 0,
  finalLibrary: false,
  extract: 'idle',
  extractDone: 0,
  extractTotal: 0,
  extractFps: 0,
  autoExtract: true,
};

/** A rail input from step-view input (the rail and the step panels share it). */
function rail(over: Partial<StepInput> = {}, extra: Partial<RailTrackInput> = {}) {
  const s = { ...step, ...over };
  return {
    steps: stepViews(s),
    live: s.live,
    total: s.total,
    settleFrames: 1000,
    setup: null,
    processed: s.processed,
    settleFed: s.settleFed,
    settleTotal: s.settleTotal,
    extractDone: s.extractDone,
    extractTotal: s.extractTotal,
    discover: s.discover,
    ...extra,
  };
}

const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);

describe('stageShares', () => {
  it('sizes stages by expected duration, summing to 1', () => {
    const s = stageShares(10_000, 10_000, { discover: true, settle: true, extract: true });
    expect(sum(s)).toBeCloseTo(1, 12);
    expect(s.discover).toBeCloseTo(s.settle, 12);
    expect(s.extract).toBeGreaterThanOrEqual(MIN_SHARE.on);
    expect(s.discover).toBeGreaterThan(s.extract);
  });

  it('gives every stage its floor so its label fits, and an off stage less', () => {
    const s = stageShares(1000, 0, { discover: true, settle: false, extract: true });
    expect(sum(s)).toBeCloseTo(1, 12);
    expect(s.settle).toBe(MIN_SHARE.off);
    expect(s.extract).toBe(MIN_SHARE.on);
  });

  it('depends only on lengths and which stages run (it holds still during a run)', () => {
    const on = { discover: true, settle: true, extract: true };
    expect(stageShares(1000, 1000, on)).toEqual(stageShares(1000, 1000, on));
  });
});

describe('railStages', () => {
  it('draws setup as a hatched lead-in that fills before the first frame', () => {
    const [d] = railStages(rail({}, { setup: { phase: 'motion-warmup', done: 50, total: 200 } }));
    expect(d.segment.leadIn).toBe(LEAD_IN_SHARE);
    expect(d.segment.fraction).toBeCloseTo(LEAD_IN_SHARE / 4, 12);
    expect(d.segment.title).toContain('Motion template 50 / 200');
  });

  it('fills Discover past the lead-in with its own frames, with the exact count in the title', () => {
    const [d, s, e] = railStages(rail({ processed: 500, discoverFps: 100 }));
    expect(d.segment.fraction).toBeCloseTo(LEAD_IN_SHARE + (1 - LEAD_IN_SHARE) * 0.5, 12);
    expect(d.segment.title).toContain('500 / 1,000 frames (50 %)');
    expect([s.segment.state, e.segment.state]).toEqual(['waiting', 'waiting']);
  });

  it('shows paused as running with the word in its label', () => {
    const [d] = railStages(rail({ discover: 'paused', processed: 10 }));
    expect(d.segment.state).toBe('running');
    expect(d.segment.label).toBe('Discover · paused');
  });

  it('has no end on a live stream, and the later stages are off', () => {
    const r = railStages(rail({ live: true, total: Infinity, processed: 449 }));
    expect(r[0].segment.fraction).toBeNull();
    expect(r[0].segment.label).toBe('Discover · live');
    expect(r.slice(1).map((x) => x.segment.state)).toEqual(['off', 'off']);
  });

  it('marks finished stages done and places the run along the whole track', () => {
    const done = railStages(rail({ discover: 'done', finalLibrary: true, extract: 'done' }));
    expect(done.map((x) => x.segment.state)).toEqual(['done', 'done', 'done']);
    expect(trackPosition(done)).toBeCloseTo(1, 12);
    const mid = railStages(rail({ discover: 'done', settling: true, settleFed: 500 }));
    expect(trackPosition(mid)).toBeCloseTo(mid[0].share + mid[1].share / 2, 12);
  });
});

describe('time left and the label', () => {
  it("adds the later stages' expected work to the current stage's rate", () => {
    // 500 Discover frames + 1000 settle frames + 1000 Extract frames x 0.1, at 100 frames/s.
    expect(runSecondsLeft(rail({ processed: 500, discoverFps: 100 }))).toBeCloseTo(16, 9);
    expect(runSecondsLeft(rail({ processed: 500, discoverFps: 0 }))).toBeNull();
    expect(
      runSecondsLeft(rail({ live: true, total: Infinity, processed: 5, discoverFps: 30 })),
    ).toBeNull();
  });

  it('says where the current stage is, in one line', () => {
    expect(railLabel(rail({ discover: 'idle' }))).toBe('Ready');
    expect(railLabel(rail({}, { setup: { phase: 'calibrate', done: 3, total: 10 } }))).toBe(
      'Calibrating 3 / 10',
    );
    expect(railLabel(rail({ processed: 824, discoverFps: 100 }))).toBe(
      'frame 824 / 1,000 · about 15 s left',
    );
    expect(railLabel(rail({ discover: 'paused', processed: 824 }))).toBe(
      'frame 824 / 1,000 · paused',
    );
    expect(railLabel(rail({ live: true, total: Infinity, processed: 449 }))).toBe(
      'frame 449 · live',
    );
    expect(
      railLabel(
        rail({
          discover: 'done',
          processed: 1000,
          settling: true,
          settleFed: 300,
          settleFps: 50,
        }),
      ),
    ).toMatch(/^Final settle 300 \/ 1,000 · about /);
    expect(
      railLabel(rail({ discover: 'done', processed: 1000, finalLibrary: true, extract: 'done' })),
    ).toBe('frame 1,000 / 1,000 · finished');
  });

  it('rounds the time left so the line does not flicker', () => {
    expect(aboutLeft(0.4)).toBe('under a second left');
    expect(aboutLeft(2)).toBe('about 5 s left');
    expect(aboutLeft(61)).toBe('about 2 min left');
    expect(aboutLeft(3725)).toBe('about 1 h 03 min left');
  });
});

describe('RailHistory', () => {
  it('keeps the Cells range end rounded up and never lower within a run', () => {
    const h = new RailHistory();
    expect(h.cellsMax).toBe(10);
    h.addCells(0.1, 38);
    expect(h.cellsMax).toBe(50);
    h.addCells(0.2, 383);
    expect(h.cellsMax).toBe(500);
    h.addCells(0.3, 120);
    expect(h.cellsMax).toBe(500);
    h.reset();
    expect(h.cellsMax).toBe(10);
    expect(h.x).toEqual([]);
  });

  it('replaces a sample at the same track position (the Final settle and done states)', () => {
    const h = new RailHistory();
    h.addCells(0.5, 300);
    h.addCells(0.5, 338);
    h.addCells(0.6, 383);
    expect(h.x).toEqual([0.5, 0.6]);
    expect(h.cells).toEqual([338, 383]);
  });

  it('holds the most workers counted in the run', () => {
    const h = new RailHistory();
    h.addWorkers(9);
    h.addWorkers(7);
    h.addWorkers(10);
    expect(h.workers).toBe(10);
  });
});

describe('formatting', () => {
  it('rounds range ends to 1, 2 or 5 x 10^k', () => {
    expect([0, 9, 10, 11, 21, 51, 383, 1000, 1001].map((v) => niceCeil(v))).toEqual([
      10, 10, 10, 20, 50, 100, 500, 1000, 2000,
    ]);
  });

  it('prints bytes in MB or GB', () => {
    expect(formatBytes(0)).toBe('0 MB');
    expect(formatBytes(380 * 1024 ** 2)).toBe('380 MB');
    expect(formatBytes(1.44 * 1024 ** 3)).toBe('1.4 GB');
  });
});

describe('railKey', () => {
  const k = {
    discover: 'running',
    extract: 'idle',
    settling: false,
    finalLibrary: false,
    setupPhase: '',
    noFrames: false,
    libraryVersion: 3,
    hasWork: false,
    hasVisits: false,
  };

  it('changes on a new library and on the first work and visit readings', () => {
    expect(railKey({ ...k, libraryVersion: 4 })).not.toBe(railKey(k));
    expect(railKey({ ...k, hasWork: true })).not.toBe(railKey(k));
    expect(railKey({ ...k, hasVisits: true })).not.toBe(railKey(k));
    expect(railKey({ ...k, discover: 'done' })).not.toBe(railKey(k));
  });

  it('is the same for the same facts (frames read and rates alone do not refresh it)', () => {
    expect(railKey({ ...k })).toBe(railKey(k));
  });
});
