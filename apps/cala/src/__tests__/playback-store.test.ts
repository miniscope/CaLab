import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot } from 'solid-js';
import type { PipelineClient } from '../lib/frame-client.ts';
import type { PipelineStepResult } from '../lib/pipeline-types.ts';
import { createPipelineStore } from '../lib/pipeline-store.ts';

import { stepBatch } from './step-fixtures.ts';
import { testPlan } from './params-fixtures.ts';
const img = () => ({ width: 2, height: 1, data: new Float32Array(2) });

/** A batch of `count` frames from `start`, with every frame's preview of the output view (value = frame). */
function batch(start: number, count: number, withFrames: boolean): PipelineStepResult {
  const data = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) data.fill(start + i, i * 2, i * 2 + 2);
  return stepBatch(start, count, {
    previews: {
      frame: start + count - 1,
      raw: img(),
      preprocessed: img(),
      corrected: img(),
      output: img(),
      ...(withFrames
        ? { frames: { view: 'output', first: start, count, width: 2, height: 1, data } }
        : {}),
    },
  });
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('smooth playback in the pipeline store', () => {
  const g = globalThis as Record<string, unknown>;
  const saved = { raf: g.requestAnimationFrame, caf: g.cancelAnimationFrame };
  afterEach(() => {
    g.requestAnimationFrame = saved.raf;
    g.cancelAnimationFrame = saved.caf;
  });

  function setup(steps: PipelineStepResult[], clockMs: { t: number }) {
    let frameCb: ((t: number) => void) | null = null;
    g.requestAnimationFrame = (cb: (t: number) => void) => {
      frameCb = cb;
      return 1;
    };
    g.cancelAnimationFrame = () => {
      frameCb = null;
    };
    let i = 0;
    const asked: (string | null)[] = [];
    const client: PipelineClient = {
      startPipeline: (async () => testPlan(100)) as unknown as PipelineClient['startPipeline'],
      stepPipeline: () =>
        i < steps.length ? Promise.resolve(steps[i++]) : new Promise<PipelineStepResult>(() => {}),
      stopPipeline: async () => {},
      setFramePreview: async (v) => {
        asked.push(v);
      },
    };
    return createRoot(() => {
      const store = createPipelineStore(client, {}, () => clockMs.t);
      store.setPlayView('output');
      const refresh = (t: number) => {
        const cb = frameCb;
        frameCb = null;
        cb?.(t);
      };
      return { store, asked, refresh };
    });
  }

  it('asks for frames of the shown view and shows the displayed frame, evenly', async () => {
    const clock = { t: 0 };
    const { store, asked, refresh } = setup([batch(0, 8, true)], clock);
    expect(asked).toEqual(['output']);
    store.setDisplayLog(true);
    await store.start();
    await flush();
    // Frame 0 at once, then one frame every 1/rate; no rate yet means 30 fps.
    refresh(0);
    expect(store.previews()?.frame).toBe(0);
    refresh(34);
    expect(store.previews()?.frame).toBe(1);
    expect(Array.from(store.previews()!.output.data)).toEqual([1, 1]);
    refresh(68);
    expect(store.previews()?.frame).toBe(2);
    expect(store.displayLog().map((d) => d.frame)).toEqual([0, 1, 2]);
  });

  it('shows the newest frame at once on pause and drops the queue', async () => {
    const clock = { t: 0 };
    const { store, refresh } = setup([batch(0, 8, true)], clock);
    await store.start();
    await flush();
    refresh(0);
    store.pause();
    expect(store.previews()?.frame).toBe(7);
    expect(store.playbackStats().queued).toBe(0);
  });

  it('stays on the latest-frame path when the batch has no per-frame previews or smooth is off', async () => {
    const clock = { t: 0 };
    const a = setup([batch(0, 8, false)], clock);
    await a.store.start();
    await flush();
    expect(a.store.previews()?.frame).toBe(7);
    const b = setup([batch(0, 8, true)], clock);
    b.store.setSmoothPlayback(false);
    expect(b.asked.at(-1)).toBeNull();
    await b.store.start();
    await flush();
    expect(b.store.previews()?.frame).toBe(7);
    vi.restoreAllMocks();
  });

  it('gives a displayed frame only while playback lags', async () => {
    const clock = { t: 0 };
    const { store, refresh } = setup([batch(0, 8, true)], clock);
    expect(store.displayedFrame()).toBeNull();
    await store.start();
    await flush();
    refresh(0);
    expect(store.displayedFrame()).toBe(0);
    store.pause();
    expect(store.displayedFrame()).toBeNull();
    const direct = setup([batch(0, 8, false)], clock);
    await direct.store.start();
    await flush();
    expect(direct.store.displayedFrame()).toBeNull();
  });

  it('clears the queue on stop', async () => {
    const clock = { t: 0 };
    const { store } = setup([batch(0, 8, true), batch(8, 8, true)], clock);
    await store.start();
    await flush();
    store.stop();
    expect(store.playbackStats().queued).toBe(0);
    expect(store.previews()).toBeNull();
  });
});
