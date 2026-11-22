import { describe, expect, it, vi } from 'vitest';
import { createRoot } from 'solid-js';
import { createFrameClient, type WorkerLike } from '../lib/frame-client.ts';
import { MAX_FRAMES_PER_READ } from '../lib/frame-source.ts';
import type { PaceStats } from '../lib/frame-pacer.ts';
import type { PipelineStepResult } from '../lib/pipeline-engine.ts';
import { makePlan, PipelineCursor, type PipelineStep } from '../lib/pipeline-plan.ts';
import { createPipelineStore, MAX_IN_FLIGHT, ThroughputMeter } from '../lib/pipeline-store.ts';
import { downsampleFrame, previewFactor } from '../lib/preview.ts';
import { createRunHistory } from '../lib/run-history.ts';
import type { LookbackFeed } from '../lib/lookback-client.ts';
import type { FrameRequest, FrameResponse } from '../workers/frame-types.ts';

function walk(cursor: PipelineCursor): PipelineStep[] {
  const steps: PipelineStep[] = [];
  for (let s = cursor.next(); s; s = cursor.next()) steps.push(s);
  return steps;
}

describe('pipeline plan', () => {
  it('clamps the warm-ups to the recording and the batch to one read', () => {
    const p = makePlan(50, { batchSize: 1000 });
    expect(p.calibrationFrames).toBe(50);
    expect(p.motionWarmupFrames).toBe(50);
    expect(p.batchSize).toBe(MAX_FRAMES_PER_READ);
    expect(() => makePlan(0)).toThrow(RangeError);
    expect(() => makePlan(10, { batchSize: 0 })).toThrow(RangeError);
  });

  it('walks calibrate, motion warm-up, then every frame in batches', () => {
    const plan = makePlan(150, { calibrationFrames: 130, motionWarmupFrames: 20, batchSize: 64 });
    const cursor = new PipelineCursor(plan);
    const steps = walk(cursor);
    expect(steps).toEqual([
      { phase: 'calibrate', start: 0, count: 64, last: false },
      { phase: 'calibrate', start: 64, count: 64, last: false },
      { phase: 'calibrate', start: 128, count: 2, last: true },
      { phase: 'motion-warmup', start: 0, count: 20, last: true },
      { phase: 'process', start: 0, count: 64, last: false },
      { phase: 'process', start: 64, count: 64, last: false },
      { phase: 'process', start: 128, count: 22, last: true },
    ]);
    expect(cursor.done).toBe(true);
    expect(cursor.next()).toBeNull();
  });

  it('ends the recording early when truncated', () => {
    const cursor = new PipelineCursor(makePlan(100, { calibrationFrames: 8, batchSize: 8 }));
    let processed = 0;
    for (let s = cursor.next(); s; s = cursor.next()) {
      if (s.phase !== 'process') continue;
      processed += s.count;
      if (processed === 24) cursor.truncate();
    }
    expect(processed).toBe(24);
    expect(cursor.done).toBe(true);
    expect(cursor.next()).toBeNull();
  });

  it('cuts process batches at session boundaries, so each session starts a batch', () => {
    const plan = makePlan(
      30,
      { batchSize: 8, calibrationFrames: 4, motionWarmupFrames: 4 },
      [13, 13, 0, 40, 21],
    );
    expect(plan.boundaries).toEqual([13, 21]);
    const c = new PipelineCursor(plan);
    const process: [number, number][] = [];
    for (let s = c.next(); s; s = c.next())
      if (s.phase === 'process') process.push([s.start, s.count]);
    expect(process).toEqual([
      [0, 8],
      [8, 5],
      [13, 8],
      [21, 8],
      [29, 1],
    ]);
    // Warm-ups are not cut.
    expect(makePlan(30, {}, [3]).boundaries).toEqual([3]);
  });

  it('processes each frame exactly once, in order, never more than a batch at a time', () => {
    const plan = makePlan(1001, { batchSize: 7 });
    const process = walk(new PipelineCursor(plan)).filter((s) => s.phase === 'process');
    let next = 0;
    for (const s of process) {
      expect(s.start).toBe(next);
      expect(s.count).toBeLessThanOrEqual(7);
      next += s.count;
    }
    expect(next).toBe(1001);
    expect(process.filter((s) => s.last)).toHaveLength(1);
  });
});

describe('preview downsampling', () => {
  it('picks the smallest integer factor that fits', () => {
    expect(previewFactor(600, 600, 320)).toBe(2);
    expect(previewFactor(100, 50, 320)).toBe(1);
    expect(previewFactor(641, 10, 320)).toBe(3);
  });

  it('box-averages one frame of a batch, with partial edge blocks', () => {
    // Two 3x2 frames; take the second.
    const batch = new Float32Array([0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6]);
    const img = downsampleFrame(batch, 1, 3, 2, 2);
    expect(img.width).toBe(2);
    expect(img.height).toBe(1);
    expect(Array.from(img.data)).toEqual([(1 + 2 + 4 + 5) / 4, (3 + 6) / 2]);
  });

  it('skips non-finite pixels', () => {
    const img = downsampleFrame(new Float32Array([NaN, 2, Infinity, 4]), 0, 2, 2, 2);
    expect(Array.from(img.data)).toEqual([3]);
  });
});

describe('throughput', () => {
  it('measures frames per second over a sliding window', () => {
    const m = new ThroughputMeter(1000);
    expect(m.record(0, 8)).toBe(0);
    expect(m.record(500, 8)).toBe(16);
    expect(m.record(1000, 8)).toBe(16);
    // The window drops the events older than 1000 ms: 8 frames over 1000 ms.
    expect(m.record(2000, 8)).toBeCloseTo(8);
  });
});

type Deferred = { resolve: (r: PipelineStepResult) => void; reject: (e: Error) => void };

/** A pipeline client whose steps resolve only when the test says so. */
function manualClient() {
  const steps: Deferred[] = [];
  return {
    steps,
    client: {
      startPipeline: vi.fn(async () => makePlan(100)),
      stepPipeline: vi.fn(
        () => new Promise<PipelineStepResult>((resolve, reject) => steps.push({ resolve, reject })),
      ),
      stopPipeline: vi.fn(async () => {}),
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function batch(start: number, count: number): PipelineStepResult {
  const image = { width: 1, height: 1, data: new Float32Array(1) };
  return {
    kind: 'batch',
    start,
    count,
    dy: new Float32Array(count).fill(1),
    dx: new Float32Array(count).fill(-2),
    quality: new Float32Array(count),
    flags: new Uint32Array(count),
    flickerOffset: new Float32Array(count),
    flickerGain: new Float32Array(count),
    previews: { frame: start, raw: image, preprocessed: image, corrected: image, output: image },
    timings: {
      readMs: count,
      preprocessMs: 2 * count,
      motionMs: 3 * count,
      otherMs: 0,
      traceMs: 0,
    },
  };
}

describe('pipeline store backpressure', () => {
  it('keeps at most MAX_IN_FLIGHT steps outstanding and refills as they finish', async () => {
    const { client, steps } = manualClient();
    await createRoot(async (dispose) => {
      const history = createRunHistory();
      const store = createPipelineStore(
        client,
        {},
        undefined,
        undefined,
        true,
        undefined,
        {},
        history,
      );
      await store.start();
      expect(store.status()).toBe('running');
      expect(client.stepPipeline).toHaveBeenCalledTimes(MAX_IN_FLIGHT);
      await flush();
      expect(client.stepPipeline).toHaveBeenCalledTimes(MAX_IN_FLIGHT);

      steps[0].resolve(batch(0, 8));
      await flush();
      expect(client.stepPipeline).toHaveBeenCalledTimes(MAX_IN_FLIGHT + 1);
      expect(store.inFlight()).toBe(MAX_IN_FLIGHT);
      expect(store.processed()).toBe(8);
      // The batch's shifts reach the run history (stream time; 20 fps without a recording rate).
      expect(history.history().at('shift_dx', 0.1)?.mean).toBe(-2);
      expect(history.now()).toBeCloseTo(8 / 20);
      expect(store.stageMs().motionMs).toBe(3);
      dispose();
    });
  });

  it('tells the frame worker the pace, and pause and resume, without holding requests itself', async () => {
    const { client, steps } = manualClient();
    const setPace = vi.fn(async () => {});
    await createRoot(async (dispose) => {
      const store = createPipelineStore({ ...client, setPace });
      store.setPaceFps(30);
      await store.start();
      expect(setPace).toHaveBeenLastCalledWith({ fps: 30 });
      // The main thread keeps its requests outstanding as without a pace: the worker's gate waits.
      expect(client.stepPipeline).toHaveBeenCalledTimes(MAX_IN_FLIGHT);
      store.pause();
      expect(setPace).toHaveBeenLastCalledWith({ paused: true });
      store.resume();
      expect(setPace).toHaveBeenLastCalledWith({ paused: false });
      store.setPaceFps(0);
      expect(setPace).toHaveBeenLastCalledWith({ fps: 0, paused: false });
      void steps;
      dispose();
    });
  });

  it('exposes the target speed as a signal (0: Max) and the floor prior for the Speed control', () => {
    const { client } = manualClient();
    createRoot((dispose) => {
      const store = createPipelineStore({ ...client, setPace: vi.fn(async () => {}) });
      expect(store.paceTarget()).toBe(0);
      expect(store.floor().prior).toBe(true);
      store.setPaceFps(80);
      expect(store.paceTarget()).toBe(80);
      store.setPaceFps(0);
      expect(store.paceTarget()).toBe(0);
      dispose();
    });
  });

  it('logs a settle cap change mid-run (Fixed 30, cap 2, then Off) and tells the listeners', async () => {
    const { client, steps } = manualClient();
    await createRoot(async (dispose) => {
      const history = createRunHistory();
      const store = createPipelineStore(
        { ...client, setPace: vi.fn(async () => {}) },
        {},
        undefined,
        undefined,
        true,
        undefined,
        {},
        history,
      );
      const seen: [number, string][] = [];
      store.onCapChange((cap, _frame, source) => seen.push([cap, source]));
      store.setPaceFps(30);
      await store.start();
      steps[0].resolve(batch(0, 8));
      await flush();
      // Before any change: the cap in force is 2, no cap event yet.
      expect(store.capNow()).toBe(2);
      expect(
        history
          .events()
          .ofKind('setting')
          .filter((e) => e.key === 'settle_cap'),
      ).toHaveLength(0);
      store.setCsettle(false);
      expect(store.capNow()).toBe(0);
      const ev = history
        .events()
        .ofKind('setting')
        .filter((e) => e.key === 'settle_cap');
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ from: 2, to: 0, frame: 8 });
      expect(ev[0].detail).toBe('Settle cap 2 per live frame → Off');
      // Off to a lower cap in two calls is one change (the ceiling alone changes nothing while Off).
      store.setCsettleCeiling(1);
      store.setCsettle(true);
      expect(seen).toEqual([
        [0, 'setting'],
        [1, 'setting'],
      ]);
      // A repeat of the same value logs nothing.
      store.setCsettle(true);
      expect(seen).toHaveLength(2);
      dispose();
    });
  });

  it('keeps URL-set targets apart, and a live run has no applied target or cap', () => {
    const { client } = manualClient();
    createRoot((dispose) => {
      const store = createPipelineStore({ ...client, setPace: vi.fn(async () => {}) });
      store.setPaceFps(30, 'url');
      expect(store.paceFromUrl()).toBe(true);
      store.setPaceFps(60, 'setting');
      expect(store.paceFromUrl()).toBe(false);
      expect(store.targetNow()).toBe(60);
      dispose();
    });
    createRoot((dispose) => {
      const store = createPipelineStore(
        { ...client, setPace: vi.fn(async () => {}) },
        {},
        undefined,
        undefined,
        true,
        undefined,
        { identity: () => ({ live: true }) as never },
      );
      store.setPaceFps(30);
      expect(store.targetNow()).toBe(0);
      expect(store.capNow()).toBe(0);
      dispose();
    });
  });

  describe('speed curve', () => {
    /** A store over a 100-frame recording (batches of 8) with the curve applied the way the app does. */
    function curveStore(dispose: () => void) {
      const { client, steps } = manualClient();
      const history = createRunHistory();
      const store = createPipelineStore(
        { ...client, setPace: vi.fn(async () => {}) },
        {},
        undefined,
        undefined,
        true,
        undefined,
        { identity: () => ({ frames: 100, width: 1, height: 1, folder: 'x' }) as never },
        history,
      );
      const seen: [number, number, string][] = [];
      store.onPaceChange((fps, frame, source) => seen.push([fps, frame, source]));
      const armed: string[] = [];
      store.onCurveArmed((c) => armed.push(`${c.preset}@${c.armed_at_frame}`));
      return { store, steps, history, seen, armed, dispose };
    }

    it('takes the first step as the run start target, changes it at the boundary, and logs source curve', async () => {
      await createRoot(async (dispose) => {
        const { store, steps, history, seen, armed } = curveStore(dispose);
        store.setPaceFps(60, 'setting');
        // Not normalised (a replay): a 30 fps step that begins at 8 % of 100 frames.
        store.setSpeedCurve(
          {
            points: [
              { at: 0, fps: 'max' },
              { at: 0.08, fps: 30 },
            ],
          },
          { preset: 'replay', normalize: false },
        );
        seen.length = 0;
        await store.start();
        // The curve's Max was applied before the run began (so 'run start' is Max, not the old 60).
        expect(store.targetNow()).toBe(0);
        expect(seen[0]).toEqual([0, 0, 'curve']);
        expect(armed).toEqual(['replay@0']);
        expect(store.curveNow()?.effective_points).toHaveLength(2);
        steps[0].resolve(batch(0, 8));
        await flush();
        expect(store.targetNow()).toBe(30);
        expect(seen[seen.length - 1]).toEqual([30, 8, 'curve']);
        // One change, logged once with its source; further batches change nothing.
        steps[1].resolve(batch(8, 8));
        await flush();
        const ev = history
          .events()
          .ofKind('setting')
          .filter((e) => e.key === 'target_speed');
        expect(ev).toHaveLength(1);
        expect(ev[0]).toMatchObject({ from: 0, to: 30, frame: 8, data: { source: 'curve' } });
        expect(ev[0].detail).toContain('(curve)');
        dispose();
      });
    });

    it('merges a step too short for the governor ramp when it normalises, and records both versions', async () => {
      await createRoot(async (dispose) => {
        const { store, steps, seen, dispose: d } = curveStore(dispose);
        store.setSpeedCurve(
          {
            points: [
              { at: 0, fps: 'max' },
              { at: 0.08, fps: 30 },
            ],
          },
          { preset: 'custom' },
        );
        await store.start();
        // 92 frames at 30 fps is 3 s, far under 20 s plus the climb: the 30 fps step is merged away.
        const rec = store.curveNow()!;
        expect(rec.points).toHaveLength(2);
        expect(rec.effective_points).toEqual([{ at: 0, fps: 'max' }]);
        steps[0].resolve(batch(0, 8));
        await flush();
        expect(store.targetNow()).toBe(0);
        expect(seen.filter(([, , src]) => src === 'curve')).toHaveLength(1);
        d();
      });
    });

    it('is taken back by anyone else setting the target, and ends with Discover', async () => {
      await createRoot(async (dispose) => {
        const { store, steps } = curveStore(dispose);
        store.setSpeedCurve(
          {
            points: [
              { at: 0, fps: 'max' },
              { at: 0.5, fps: 30 },
            ],
          },
          { normalize: false },
        );
        expect(store.speedCurve()?.curve.points).toHaveLength(2);
        await store.start();
        store.setPaceFps(45, 'setting');
        expect(store.speedCurve()).toBeNull();
        expect(store.curveNow()).toBeNull();
        steps[0].resolve(batch(0, 64));
        await flush();
        // The curve would be at 30 by now; the user's 45 stays.
        expect(store.targetNow()).toBe(45);
        dispose();
      });
    });

    it('can be chosen mid-run and follows from that frame', async () => {
      await createRoot(async (dispose) => {
        const { store, steps, armed } = curveStore(dispose);
        await store.start();
        steps[0].resolve(batch(0, 8));
        await flush();
        store.setSpeedCurve(
          {
            points: [
              { at: 0, fps: 20 },
              { at: 0.5, fps: 40 },
            ],
          },
          { normalize: false },
        );
        expect(armed).toEqual(['custom@8']);
        expect(store.targetNow()).toBe(20);
        dispose();
      });
    });

    it('installs another policy through armPolicy, and keeps the merged count of a curve', async () => {
      await createRoot(async (dispose) => {
        const { store } = curveStore(dispose);
        store.setSpeedCurve({
          points: [
            { at: 0, fps: 20 },
            { at: 0.5, fps: 40 },
          ],
        });
        await store.start();
        expect(store.armedCurve()?.merged).toBeGreaterThanOrEqual(0);
        store.armPolicy({ source: 'auto', target: () => ({ fps: 33, phase: 'p' }) }, 0, null);
        expect(store.targetNow()).toBe(33);
        dispose();
      });
    });

    it('Auto arms its policy at the run start (source auto) and any other setter takes it back', async () => {
      await createRoot(async (dispose) => {
        const { store, seen } = curveStore(dispose);
        store.setSpeedCurve({ points: [{ at: 0, fps: 20 }] });
        store.setAutoBudget(1);
        expect(store.autoBudget()).toBe(1);
        expect(store.speedCurve()).toBeNull();
        seen.length = 0;
        await store.start();
        // Max is not measured yet: Auto goes at Max, as an Auto change.
        expect(seen[0]).toEqual([0, 0, 'auto']);
        expect(store.autoNow()).toEqual({ extraTimeShare: 1, decisions: [] });
        expect(store.curveNow()).toBeNull();
        store.setPaceFps(40, 'setting');
        expect(store.autoBudget()).toBeNull();
        expect(store.autoNow()).toBeNull();
        store.setAutoBudget(2);
        store.setSpeedCurve({ points: [{ at: 0, fps: 20 }] });
        expect(store.autoBudget()).toBeNull();
        dispose();
      });
    });

    it('without a frame count, Auto and a curve hold Max rather than a stale Fixed target', async () => {
      for (const kind of ['auto', 'curve']) {
        await createRoot(async (dispose) => {
          const { client } = manualClient();
          const store = createPipelineStore(
            { ...client, setPace: vi.fn(async () => {}) },
            {},
            undefined,
            undefined,
            true,
            undefined,
            { identity: () => ({ width: 1, height: 1, folder: 'x' }) as never },
          );
          store.setPaceFps(40, 'setting');
          if (kind === 'auto') store.setAutoBudget(1);
          else store.setSpeedCurve({ points: [{ at: 0, fps: 20 }] });
          expect(store.targetNow()).toBe(40);
          await store.start();
          expect(store.targetNow()).toBe(0);
          dispose();
        });
      }
    });

    it('does nothing for a stream (no frame count), and a curve of nothing clears it', () => {
      createRoot((dispose) => {
        const { client } = manualClient();
        const store = createPipelineStore(
          { ...client, setPace: vi.fn(async () => {}) },
          {},
          undefined,
          undefined,
          true,
          undefined,
          { identity: () => ({ live: true }) as never },
        );
        store.setSpeedCurve({ points: [{ at: 0, fps: 20 }] });
        expect(store.speedCurve()).not.toBeNull();
        void store.start();
        expect(store.curveNow()).toBeNull();
        store.setSpeedCurve({ points: [] });
        expect(store.speedCurve()).toBeNull();
        dispose();
      });
    });
  });

  it('never leaves the gate held: pause, pace off, resume, pace on', async () => {
    const { client } = manualClient();
    const setPace = vi.fn(async () => {});
    await createRoot(async (dispose) => {
      const store = createPipelineStore({ ...client, setPace });
      store.setPaceFps(30);
      await store.start();
      store.pause();
      store.setPaceFps(0);
      store.resume();
      expect(setPace).toHaveBeenLastCalledWith({ paused: false });
      store.setPaceFps(20);
      expect(setPace).toHaveBeenLastCalledWith({ fps: 20, paused: false });
      // Paused with no pace, then a pace: the gate starts held.
      store.setPaceFps(0);
      store.pause();
      store.setPaceFps(15);
      expect(setPace).toHaveBeenLastCalledWith({ fps: 15, paused: true });
      dispose();
    });
  });

  it('sends no pace message when no pace is set', async () => {
    const { client } = manualClient();
    const setPace = vi.fn(async () => {});
    await createRoot(async (dispose) => {
      const store = createPipelineStore({ ...client, setPace });
      await store.start();
      store.pause();
      store.resume();
      expect(setPace).not.toHaveBeenCalled();
      dispose();
    });
  });

  it("drops pacing readouts of another session or an older gate run, keeps a stopped run's last one", async () => {
    const { client } = manualClient();
    let listener: ((s: PaceStats) => void) | null = null;
    const stats = (session: number, released: number, epoch = 5): PaceStats => ({
      session,
      epoch,
      target: 30,
      waitMs: 0,
      lateMs: 0,
      reanchors: 0,
      released,
    });
    await createRoot(async (dispose) => {
      const store = createPipelineStore({
        ...client,
        subscribePaceStats: (l: (s: PaceStats) => void) => {
          listener = l;
          return () => {};
        },
      });
      await store.start();
      // The session the frame worker was started with: the one `startPipeline` was given.
      const session = (
        client.startPipeline.mock.calls[0] as unknown as [unknown, { session: number }]
      )[1].session;
      listener!(stats(session - 1, 99));
      expect(store.paceStats()).toBeNull();
      listener!(stats(session, 16));
      expect(store.paceStats()?.released).toBe(16);
      // An older gate run of the same session (a late readout before a replay began).
      listener!(stats(session, 99, 4));
      expect(store.paceStats()?.released).toBe(16);
      store.stop();
      expect(store.paceStats()?.released).toBe(16);
      // The stopped run's final readout (the worker flushes it on stop) lands.
      listener!(stats(session, 24));
      expect(store.paceStats()?.released).toBe(24);
      // A new start clears it; the old session's readouts no longer count.
      await store.start();
      expect(store.paceStats()).toBeNull();
      listener!(stats(session, 30));
      expect(store.paceStats()).toBeNull();
      dispose();
    });
  });

  it('estimates the fast loop top speed from the busy time of its stages', async () => {
    const { client, steps } = manualClient();
    await createRoot(async (dispose) => {
      const store = createPipelineStore(client);
      await store.start();
      expect(store.maxFps()).toBe(0);
      // batch(): 1 + 2 + 3 ms a frame in series: 6 ms a frame.
      steps[0].resolve(batch(0, 8));
      await flush();
      expect(store.maxFps()).toBeCloseTo(1000 / 6);
      store.stop();
      expect(store.maxFps()).toBe(0);
      dispose();
    });
  });

  it('keeps whole-run timing averages over a long batch and resets them on stop', async () => {
    const { client, steps } = manualClient();
    await createRoot(async (dispose) => {
      const store = createPipelineStore(client);
      await store.start();
      const count = 40_000;
      steps[0].resolve(batch(0, count));
      await flush();
      expect(store.processed()).toBe(count);
      expect(store.stageMs().motionMs).toBe(3);
      expect(store.stageMs().preprocessMs).toBe(2);
      store.stop();
      expect(store.processed()).toBe(0);
      expect(store.stageMs().motionMs).toBe(0);
      dispose();
    });
  });

  it('offers the look-back toggle when the feed says nothing blocks it', () => {
    const { client } = manualClient();
    createRoot((dispose) => {
      let why: string | null = null;
      const feed = {
        blocked: () => why,
        begin: () => true,
        rows: () => {},
        backState: () => {},
        flatField: () => {},
        reset: () => {},
      };
      const args = [undefined, undefined, undefined, undefined, {}, undefined, undefined] as const;
      const store = createPipelineStore(client, {}, ...args, feed);
      expect(store.lookbackBlocked()).toBeNull();
      why = 'Open a recording first.';
      expect(store.lookbackBlocked()).toBe('Open a recording first.');
      expect(createPipelineStore(client).lookbackBlocked()).toBe(
        'Look-back is not available here.',
      );
      dispose();
    });
  });

  it('stops requesting while paused and resumes', async () => {
    const { client, steps } = manualClient();
    await createRoot(async (dispose) => {
      const store = createPipelineStore(client);
      await store.start();
      store.pause();
      steps[0].resolve(batch(0, 8));
      steps[1].resolve(batch(8, 8));
      await flush();
      // Answers to steps already sent still count, but nothing new is asked.
      expect(store.processed()).toBe(16);
      expect(client.stepPipeline).toHaveBeenCalledTimes(2);
      expect(store.inFlight()).toBe(0);
      store.resume();
      expect(client.stepPipeline).toHaveBeenCalledTimes(2 + MAX_IN_FLIGHT);
      dispose();
    });
  });

  it('finishes on done and stops asking', async () => {
    const { client, steps } = manualClient();
    await createRoot(async (dispose) => {
      const store = createPipelineStore(client);
      await store.start();
      steps[0].resolve({ kind: 'done' });
      steps[1].resolve({ kind: 'done' });
      await flush();
      expect(store.status()).toBe('done');
      expect(client.stepPipeline).toHaveBeenCalledTimes(2);
      dispose();
    });
  });

  it('reports a worker error and drops answers from a stopped run', async () => {
    const { client, steps } = manualClient();
    await createRoot(async (dispose) => {
      const store = createPipelineStore(client);
      await store.start();
      steps[0].reject(new Error('boom'));
      await flush();
      expect(store.status()).toBe('error');
      expect(store.error()).toBe('boom');

      store.stop();
      expect(client.stopPipeline).toHaveBeenCalledTimes(1);
      steps[1].resolve(batch(0, 8));
      await flush();
      expect(store.processed()).toBe(0);
      expect(store.status()).toBe('idle');
      dispose();
    });
  });
});

/** A fake worker that answers each request through `reply`. */
function fakeWorker(reply: (req: FrameRequest) => FrameResponse) {
  const sent: FrameRequest[] = [];
  const worker: WorkerLike & { emit(msg: FrameResponse): void } = {
    onmessage: null,
    onerror: null,
    postMessage(msg: FrameRequest) {
      sent.push(msg);
      queueMicrotask(() => worker.emit(reply(msg)));
    },
    terminate: vi.fn(),
    emit(msg) {
      worker.onmessage?.call(worker as unknown as Worker, { data: msg } as MessageEvent);
    },
  };
  return { worker, sent };
}

describe('pipeline store: Background settle and the settle pool', () => {
  function feedSpy(order: string[]) {
    const calls: { cap: number[]; pace: [number, boolean][]; pool: number[] } = {
      cap: [],
      pace: [],
      pool: [],
    };
    const feed: LookbackFeed = {
      blocked: () => null,
      begin: () => true,
      rows: () => {},
      backState: () => {},
      flatField: () => {},
      reset: () => {},
      pace: (fps, paused) => {
        order.push('pace');
        calls.pace.push([fps, paused]);
      },
      cap: (c) => {
        order.push('cap');
        calls.cap.push(c);
      },
      startPool: (session) => {
        calls.pool.push(session);
        return 1;
      },
    };
    return { feed, calls };
  }
  const make = (feed: LookbackFeed, client: ReturnType<typeof manualClient>['client']) =>
    createPipelineStore(
      client,
      {},
      undefined,
      undefined,
      true,
      undefined,
      {},
      undefined,
      undefined,
      feed,
    );

  it('a run at Max sends the cap and target before its start and never starts the pool', async () => {
    const order: string[] = [];
    const { feed, calls } = feedSpy(order);
    const { client } = manualClient();
    client.startPipeline.mockImplementation(async () => {
      order.push('start');
      return makePlan(100);
    });
    await createRoot(async (dispose) => {
      const store = make(feed, client);
      store.setLookback(true);
      await store.start();
      expect(order.slice(0, 3)).toEqual(['cap', 'pace', 'start']);
      expect(calls.cap).toEqual([2]);
      expect(calls.pace.at(-1)).toEqual([0, false]);
      const cells = (
        client.startPipeline.mock.calls[0] as unknown as [unknown, { csettle?: boolean }]
      )[1];
      expect(cells.csettle).toBe(true);
      store.setCsettleCeiling(1);
      store.setCsettle(false);
      expect(calls.cap.slice(-2)).toEqual([1, 0]);
      expect(calls.pool).toEqual([]);
      dispose();
    });
  });

  it('going below Max mid-run starts the pool for that run (with the settle on), never after the run', async () => {
    const order: string[] = [];
    const { feed, calls } = feedSpy(order);
    const { client } = manualClient();
    await createRoot(async (dispose) => {
      const store = make(feed, client);
      const started: [number, number][] = [];
      store.onPoolStart((workers, frame) => started.push([workers, frame]));
      store.setLookback(true);
      store.setCsettle(false);
      await store.start();
      const session = (
        client.startPipeline.mock.calls[0] as unknown as [unknown, { session: number }]
      )[1].session;
      store.setPaceFps(60);
      // Cap Off: no pool yet.
      expect(calls.pool).toEqual([]);
      expect(started).toEqual([]);
      store.setCsettle(true);
      expect(calls.pool).toEqual([session]);
      // The run record hears of the first start only.
      store.setPaceFps(45);
      expect(started).toEqual([[1, 0]]);
      store.stop();
      store.setPaceFps(30);
      expect(calls.pool).toEqual([session, session]);
      expect(started).toHaveLength(1);
      dispose();
    });
  });

  it('a run started below Max starts the pool before its start', async () => {
    const order: string[] = [];
    const { feed, calls } = feedSpy(order);
    const { client } = manualClient();
    client.startPipeline.mockImplementation(async () => {
      order.push('start');
      return makePlan(100);
    });
    await createRoot(async (dispose) => {
      const store = make(feed, client);
      store.setLookback(true);
      store.setPaceFps(60);
      await store.start();
      expect(calls.pool).toHaveLength(1);
      expect(order.indexOf('start')).toBeGreaterThan(order.indexOf('pace'));
      dispose();
    });
  });
});

describe('pipeline message protocol', () => {
  it('pairs start/step/stop requests with their responses by id', async () => {
    const plan = makePlan(10);
    const { worker, sent } = fakeWorker((req) => {
      switch (req.type) {
        case 'pipeline-start':
          return { type: 'pipeline-ready', id: req.id, plan };
        case 'pipeline-step':
          return { type: 'pipeline-step', id: req.id, step: { kind: 'done' } };
        case 'pipeline-stop':
          return { type: 'pipeline-stopped', id: req.id };
        default:
          return { type: 'error', id: req.id, message: 'unexpected' };
      }
    });
    const client = createFrameClient(() => worker);
    expect(await client.startPipeline({ batchSize: 4 })).toEqual(plan);
    expect(await client.stepPipeline()).toEqual({ kind: 'done' });
    await client.stopPipeline();
    expect(sent.map((r) => r.type)).toEqual(['pipeline-start', 'pipeline-step', 'pipeline-stop']);
    expect(sent[0]).toMatchObject({ options: { batchSize: 4 } });
    expect(new Set(sent.map((r) => r.id)).size).toBe(3);
  });

  it('rejects on a worker error or a mismatched response', async () => {
    const { worker } = fakeWorker((req) =>
      req.type === 'pipeline-step'
        ? { type: 'error', id: req.id, message: 'The pipeline is not running.' }
        : { type: 'pipeline-stopped', id: req.id },
    );
    const client = createFrameClient(() => worker);
    await expect(client.stepPipeline()).rejects.toThrow('not running');
    await expect(client.startPipeline()).rejects.toThrow('Unexpected worker response');
  });
});
