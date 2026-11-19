import { describe, expect, it } from 'vitest';
import {
  createStageLog,
  discoverErrorData,
  EXTRACT_AFTER_DISCOVER_DEFAULT,
  extractEndData,
  factorRefineDoneText,
  factorRefineRunningText,
  footprintChange,
  LIVE_FACTORS_NOTE,
  LIVE_NOTE,
  LIVE_REFINE_OFF,
  NEXT_STEP_HINT,
  perMinute,
  refineComparison,
  showNextStepHint,
  stageAvailability,
  type StageInput,
  type StageRun,
} from '../lib/run-stages.ts';
import type { Pass2Result } from '../lib/pass2-store.ts';
import type { FactorIteration, LibraryView } from '../workers/slow-types.ts';

const READY: StageInput = {
  live: false,
  discover: 'done',
  refine: 'idle',
  extract: 'idle',
  finalLibrary: true,
  cells: 12,
  replayBlocked: null,
};

describe('stage availability (the order of the stages)', () => {
  it('runs Refine and Extract only after Discover has finished with its final library', () => {
    expect(stageAvailability(READY)).toEqual({ discover: null, refine: null, extract: null });
    for (const discover of ['idle', 'running', 'error'] as const) {
      const a = stageAvailability({ ...READY, discover });
      expect(a.refine).toMatch(/Discover/);
      expect(a.extract).toMatch(/Discover/);
    }
    const waiting = stageAvailability({ ...READY, finalLibrary: false });
    expect(waiting.refine).toMatch(/final library/);
    expect(waiting.extract).toMatch(/final library/);
    expect(stageAvailability({ ...READY, cells: 0 }).refine).toMatch(/No cells/);
    expect(stageAvailability({ ...READY, replayBlocked: 'gap' }).extract).toBe('gap');
  });

  it('runs one replay at a time: no Extract during Refine and no Refine during Extract', () => {
    const refining = stageAvailability({ ...READY, refine: 'running' });
    expect(refining.extract).toBe('Refine is running.');
    expect(refining.refine).toBe('Refine is running.');
    expect(refining.discover).toBe('Refine is running.');
    const extracting = stageAvailability({ ...READY, extract: 'running' });
    expect(extracting.refine).toBe('Extract is running.');
    // Refine after Extract, Extract after Refine, Refine again: all allowed.
    expect(stageAvailability({ ...READY, extract: 'done' }).refine).toBeNull();
    expect(stageAvailability({ ...READY, refine: 'done' }).extract).toBeNull();
    expect(stageAvailability({ ...READY, refine: 'done' }).refine).toBeNull();
    expect(stageAvailability({ ...READY, refine: 'cancelled' }).refine).toBeNull();
  });

  it('streams Discover only, with the note about loading a saved stream', () => {
    const a = stageAvailability({ ...READY, live: true });
    expect(a.discover).toBeNull();
    expect(a.refine).toBe(LIVE_NOTE);
    expect(a.extract).toBe(LIVE_NOTE);
    expect(LIVE_NOTE).toMatch(/load it as a recording/);
  });
});

describe('stage log', () => {
  it('numbers the runs per stage, closes the newest one, and starts over', () => {
    let t = Date.parse('2026-11-13T10:00:00Z');
    const log = createStageLog(() => new Date((t += 1000)));
    log.begin('discover');
    log.end('discover', 'done', { frames: 600, refines: 30 });
    log.begin('refine');
    log.end('refine', 'done', { refines: 10 });
    log.begin('refine');
    expect(log.runs().map((r) => `${r.stage}${r.index}:${r.outcome}`)).toEqual([
      'discover1:done',
      'refine1:done',
      'refine2:running',
    ]);
    log.end('refine', 'cancelled', { frames: 100 });
    expect(log.last('refine')).toMatchObject({ index: 2, outcome: 'cancelled', frames: 100 });
    expect(log.runs()[0].startedAt).toBe('2026-11-13T10:00:01.000Z');
    expect(log.runs()[0].endedAt).toBe('2026-11-13T10:00:02.000Z');
    // Ending a stage that is not running changes nothing.
    log.end('extract', 'done', {});
    expect(log.runs()).toHaveLength(3);
    log.reset();
    expect(log.runs()).toEqual([]);
  });

  it('marks Extract invalidated by a Refine until Extract runs again', () => {
    const log = createStageLog();
    log.invalidateExtract();
    expect(log.extractInvalidated()).toBe(true);
    log.begin('extract');
    expect(log.extractInvalidated()).toBe(false);
  });
});

function view(cells: [number, [number, number][]][]): LibraryView {
  const ids = Uint32Array.from(cells.map((c) => c[0]));
  const starts = [0];
  const pixels: number[] = [];
  const values: number[] = [];
  for (const [, px] of cells) {
    for (const [p, v] of px) {
      pixels.push(p);
      values.push(v);
    }
    starts.push(pixels.length);
  }
  return {
    version: 1,
    frame: 0,
    width: 10,
    height: 10,
    ids,
    centers: new Float32Array(2 * ids.length),
    radii: new Float32Array(ids.length),
    starts: Uint32Array.from(starts),
    pixels: Uint32Array.from(pixels),
    values: Float32Array.from(values),
  };
}

describe('Refine readout', () => {
  it('counts the refined footprints and takes the median relative change of those', () => {
    const before = view([
      [1, [[0, 1]]],
      [2, [[5, 2]]],
      [3, [[9, 1]]],
    ]);
    const after = view([
      [1, [[0, 1]]],
      // |(0, 1) - (2, 0)| / |2| = sqrt(5) / 2
      [
        2,
        [
          [5, 0],
          [6, 1],
        ],
      ],
      // Grows: |0.5| / 1
      [3, [[9, 1.5]]],
    ]);
    const c = footprintChange(before, after);
    expect(c.refined).toBe(2);
    expect(c.cells).toBe(3);
    // Median of (sqrt(5) / 2, 0.5).
    expect(c.median).toBeCloseTo((Math.sqrt(5) / 2 + 0.5) / 2);
    expect(footprintChange(before, before)).toEqual({ refined: 0, median: null, cells: 3 });
    expect(footprintChange(before, view([[7, [[0, 1]]]])).median).toBeNull();
  });

  it('rates refines per minute of recording', () => {
    expect(perMinute(30, 1200, 20)).toBe(30);
    expect(perMinute(30, 1200, 0)).toBeNull();
  });

  const run = (stage: StageRun['stage'], refinesPerMin: number, refines = 1): StageRun => ({
    stage,
    index: 1,
    startedAt: '',
    endedAt: '',
    outcome: 'done',
    frames: 1200,
    cells: 10,
    libraryVersion: 1,
    refines,
    refinesPerMin,
  });

  it('compares a Refine with the run before it, and calls it settled from the ratios alone', () => {
    expect(refineComparison([run('discover', 100)])).toBeNull();
    // Refine 1 against Discover: falling, not settled (no earlier ratio to compare).
    const one = refineComparison([run('discover', 100), run('refine', 50)])!;
    expect(one.ratio).toBeCloseTo(0.5);
    expect(one.previous?.stage).toBe('discover');
    expect(one.settled).toBe(false);
    // Still falling faster: 0.3 < 0.5.
    expect(
      refineComparison([run('discover', 100), run('refine', 50), run('refine', 15)])!.settled,
    ).toBe(false);
    // The fall levelled off: 0.8 >= 0.3.
    const flat = refineComparison([
      run('discover', 100),
      run('refine', 50),
      run('refine', 15),
      run('refine', 12),
    ])!;
    expect(flat.ratio).toBeCloseTo(0.8);
    expect(flat.settled).toBe(true);
    // A rising rate is not settled, even after a steeper fall.
    expect(
      refineComparison([run('discover', 100), run('refine', 50), run('refine', 60)])!.settled,
    ).toBe(false);
    // No refines at all: settled.
    expect(refineComparison([run('discover', 100), run('refine', 0, 0)])!.settled).toBe(true);
    // Extract runs in between do not count; cancelled runs are skipped.
    const mixed = refineComparison([
      run('discover', 100),
      { ...run('extract', 0), refinesPerMin: undefined },
      { ...run('refine', 1), outcome: 'cancelled' },
      run('refine', 40),
    ])!;
    expect(mixed.previous?.stage).toBe('discover');
    expect(mixed.ratio).toBeCloseTo(0.4);
  });
});

describe('Extract after Discover default and the next-step hint', () => {
  const HINT_IN = {
    live: false,
    discover: 'done',
    refine: 'idle',
    extract: 'idle',
    refineRuns: 0,
  } as const;

  it('is off by default for recordings', () => {
    expect(EXTRACT_AFTER_DISCOVER_DEFAULT).toBe(false);
  });

  it('shows the hint after Discover, before any Refine or Extract', () => {
    expect(NEXT_STEP_HINT).toBe('Refine to let footprints settle, then Extract final traces.');
    expect(showNextStepHint(HINT_IN)).toBe(true);
  });

  it('hides the hint for live streams, during Discover, and once Refine or Extract has run', () => {
    expect(showNextStepHint({ ...HINT_IN, live: true })).toBe(false);
    expect(showNextStepHint({ ...HINT_IN, discover: 'running' })).toBe(false);
    expect(showNextStepHint({ ...HINT_IN, refine: 'running' })).toBe(false);
    expect(showNextStepHint({ ...HINT_IN, refineRuns: 1 })).toBe(false);
    expect(showNextStepHint({ ...HINT_IN, extract: 'running' })).toBe(false);
    expect(showNextStepHint({ ...HINT_IN, extract: 'done' })).toBe(false);
  });
});

describe('what the stage records carry when a stage ends', () => {
  const result = (extra: object = {}) =>
    ({
      frames: 8,
      cells: 2,
      version: 3,
      source: 'factors',
      tiling: 'offset',
      meanRank: 4.5,
      minValid: Float32Array.of(0.5, 0.75),
      ...extra,
    }) as unknown as Pass2Result;
  const store = (res: Pass2Result | null, source: 'raw' | 'factors') => ({
    result: () => res,
    processed: () => 5,
    source: () => source,
  });

  it('a factor Extract says whose factors it read', () => {
    expect(extractEndData('done', store(result({ factors: 'discover' }), 'factors')).factors).toBe(
      'discover',
    );
    expect('factors' in extractEndData('done', store(result(), 'factors'))).toBe(false);
  });

  it('a failed Discover says it read the recording', () => {
    expect(discoverErrorData(12)).toEqual({ frames: 12, source: 'raw' });
  });

  it('a failed or cancelled Extract says where it was reading', () => {
    for (const outcome of ['error', 'cancelled'] as const) {
      expect(extractEndData(outcome, store(null, 'factors'))).toEqual({
        frames: 5,
        source: 'factors',
      });
      expect(extractEndData(outcome, store(null, 'raw'))).toEqual({ frames: 5, source: 'raw' });
    }
  });

  it('a factor Extract that finished counts its cells below 1, a raw one has none', () => {
    expect(extractEndData('done', store(result(), 'factors'))).toEqual({
      frames: 8,
      cells: 2,
      libraryVersion: 3,
      source: 'factors',
      tiling: 'offset',
      meanRank: 4.5,
      lowValid: 2,
    });
    const allValid = result({ minValid: Float32Array.of(1, 1) });
    expect(extractEndData('done', store(allValid, 'factors')).lowValid).toBe(0);
    const raw = result({
      source: 'raw',
      tiling: undefined,
      meanRank: undefined,
      minValid: undefined,
    });
    const data = extractEndData('done', store(raw, 'raw'));
    expect(data).toEqual({ frames: 8, cells: 2, libraryVersion: 3, source: 'raw' });
    expect('lowValid' in data).toBe(false);
  });
});

describe('stage availability of a live run with compression on', () => {
  const LIVE: StageInput = { ...READY, live: true, liveFactors: null };

  it('offers Extract once the stream ended and its factors are ready, Refine only with ?refine=factors', () => {
    expect(stageAvailability(LIVE)).toEqual({
      discover: null,
      refine: LIVE_REFINE_OFF,
      extract: null,
    });
    expect(stageAvailability({ ...LIVE, refineOnFactors: true }).refine).toBeNull();
    expect(stageAvailability({ ...LIVE, discover: 'running' }).extract).toBe(
      'Discover is running.',
    );
    expect(stageAvailability({ ...LIVE, discover: 'error' }).extract).toBe(
      'Extract runs after Discover finishes.',
    );
    const blocked = { ...LIVE, liveFactors: "The stream's last windows are being compressed." };
    expect(stageAvailability(blocked).extract).toBe(
      "The stream's last windows are being compressed.",
    );
    expect(stageAvailability({ ...blocked, refineOnFactors: true }).refine).toBe(
      "The stream's last windows are being compressed.",
    );
    expect(stageAvailability({ ...LIVE, cells: 0 }).extract).toMatch(/No cells/);
    expect(stageAvailability({ ...LIVE, refine: 'running', refineOnFactors: true }).extract).toBe(
      'Refine is running.',
    );
    expect(LIVE_REFINE_OFF).toBe(
      'A live stream has no file to replay: Refine runs on the factors only with ?refine=factors.',
    );
    expect(LIVE_FACTORS_NOTE).toBe(
      'Live run: Extract and Refine read the factors Discover wrote during the stream; they are not claimed to meet the closeness gate.',
    );
  });

  it('does not report a replay reason for a stream, which replays nothing', () => {
    const gap = { ...LIVE, refineOnFactors: true, replayBlocked: 'motion record has a gap' };
    expect(stageAvailability(gap)).toMatchObject({ refine: null, extract: null });
    expect(
      stageAvailability({ ...gap, liveFactors: 'The last windows are being compressed.' }).extract,
    ).toBe('The last windows are being compressed.');
  });

  it('keeps the live note when compression is off, with or without the switch', () => {
    expect(stageAvailability({ ...READY, live: true, refineOnFactors: true })).toMatchObject({
      refine: LIVE_NOTE,
      extract: LIVE_NOTE,
    });
  });
});

describe('the readouts of Refine on the factors', () => {
  const S = { maxIterations: 20, settleShare: 0.02 };
  const it2: FactorIteration = {
    iteration: 2,
    libraryVersion: 9,
    cells: 40,
    frames: 1200,
    fittingFrames: 800,
    accepted: 5,
    changedShare: 0.04,
    medianChange: 0.003,
    lowValid: 0,
    tilesSkipped: 0,
    ms: 10,
  };

  it('say what a running one does', () => {
    expect(factorRefineRunningText(1, { kind: 'compress', done: 1200, total: 3000 }, S)).toBe(
      'Refine 1: preparing the factors: frame 1,200 / 3,000',
    );
    expect(factorRefineRunningText(1, { kind: 'wait', for: 'compression', pending: 3 }, S)).toBe(
      'Refine 1: waiting for the factors (3 windows still to compress)',
    );
    expect(factorRefineRunningText(1, { kind: 'wait', for: 'compression', pending: 0 }, S)).toBe(
      'Refine 1: waiting for the factors',
    );
    expect(factorRefineRunningText(1, { kind: 'wait', for: 'extract', pending: 0 }, S)).toBe(
      'Refine 1: waiting for the last Extract on the factors to end',
    );
    expect(factorRefineRunningText(1, { kind: 'iterate', last: null, stopping: false }, S)).toBe(
      'Refine 1 on the factors: iteration 1 of at most 20',
    );
    expect(factorRefineRunningText(2, { kind: 'iterate', last: it2, stopping: true }, S)).toBe(
      'Refine 2 on the factors: iteration 2 of at most 20 done · 5 refinements accepted · 4.0% of cells still changing (settled below 2.0%) · median change 0.3% · stopping after this iteration',
    );
  });

  it('say how a finished one stopped', () => {
    const run = {
      stage: 'refine',
      index: 1,
      startedAt: '',
      endedAt: '',
      outcome: 'done',
      frames: 1200,
      cells: 40,
      libraryVersion: 9,
      footprintsRefined: 30,
      medianFootprintChange: 0.012,
      source: 'factors',
      iterations: 6,
      changedShare: 0.031,
    } as const;
    const tail = '30 of 40 footprints refined · median change of those 1.2%';
    expect(factorRefineDoneText({ ...run, stop: 'settled' })).toBe(
      `Refine 1 on the factors: settled after 6 iterations · ${tail}`,
    );
    expect(factorRefineDoneText({ ...run, iterations: 1, stop: 'nothing-accepted' })).toBe(
      `Refine 1 on the factors: settled after 1 iteration (the last accepted no refinement) · ${tail}`,
    );
    expect(factorRefineDoneText({ ...run, iterations: 20, stop: 'cap' })).toBe(
      `Refine 1 on the factors: stopped at the cap of 20 iterations without settling (3.1% of cells still changing) · ${tail}`,
    );
    expect(
      factorRefineDoneText({ ...run, outcome: 'cancelled', iterations: 4, stop: 'stopped' }),
    ).toBe(`Refine 1 on the factors (cancelled after 4 iterations): ${tail}`);
    expect(factorRefineDoneText({ ...run, outcome: 'error', iterations: 0, stop: 'error' })).toBe(
      `Refine 1 on the factors (stopped by an error after 0 iterations): ${tail}`,
    );
  });

  it('falls back on the outcome when a record has no stop', () => {
    const run = {
      stage: 'refine',
      index: 1,
      startedAt: '',
      endedAt: '',
      outcome: 'cancelled',
      frames: 1200,
      cells: 40,
      libraryVersion: 9,
      footprintsRefined: 30,
      medianFootprintChange: 0.012,
      source: 'factors',
      iterations: 4,
    } as const;
    const tail = '30 of 40 footprints refined · median change of those 1.2%';
    expect(factorRefineDoneText(run)).toBe(
      `Refine 1 on the factors (cancelled after 4 iterations): ${tail}`,
    );
    expect(factorRefineDoneText({ ...run, outcome: 'error' })).toBe(
      `Refine 1 on the factors (stopped by an error after 4 iterations): ${tail}`,
    );
  });
});
