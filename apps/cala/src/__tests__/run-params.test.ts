// @vitest-environment node
/**
 * The run's params from the app's settings to the engine: the layer the pipeline store builds,
 * the frame worker's resolution, the worker init messages, and the WASM objects built from them.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  MotionCorrector,
  QcMonitor,
  ResolvedParams,
  SlowLoop,
  VisitWorker,
} from '../lib/cala-wasm.ts';
import { FastLoop, type TraceBackend } from '../lib/fast-loop.ts';
import type { PipelineClient } from '../lib/frame-client.ts';
import type { LookbackFeed } from '../lib/lookback-client.ts';
import { paramsHandle, resolveRunParams } from '../lib/params-handle.ts';
import type { PipelineOptions } from '../lib/pipeline-plan.ts';
import { createPipelineStore } from '../lib/pipeline-store.ts';
import { fastLoopOptions } from '../lib/run-cells.ts';
import { runParams, runParamsLayer, type ParamsLayer } from '../lib/run-params.ts';
import { buildSlowLoop } from '../lib/slow-runner.ts';
import { StageChain } from '../lib/stage-chain.ts';
import type { FastToSlow, SlowInit } from '../workers/slow-types.ts';
import { blobMovie } from './blob-movie.ts';
import { testPlan } from './params-fixtures.ts';
import { initTestWasm } from './wasm-test.ts';

beforeAll(initTestWasm);

const golden = (fps: number): unknown =>
  JSON.parse(
    readFileSync(
      resolve(
        import.meta.dirname,
        `../../../../crates/cala/tests/golden/engine-view-fps${fps}.json`,
      ),
      'utf8',
    ),
  );

/** A look-back feed that accepts every run (a recording on disk). */
function lookbackFeed(): LookbackFeed {
  return {
    blocked: () => null,
    begin: () => true,
    rows: () => {},
    backState: () => {},
    flatField: () => {},
    params: vi.fn(),
    reset: () => {},
  };
}

/** The pipeline options the store's Discover start sends with `options` (its caller's). */
async function startOptions(options: PipelineOptions = {}): Promise<PipelineOptions> {
  const startPipeline = vi.fn(async () => testPlan(100));
  const client: PipelineClient = {
    startPipeline,
    stepPipeline: () => new Promise(() => {}),
    stopPipeline: async () => {},
    // The app's client has the flat-field estimator worker.
    subscribeFlatField: () => () => {},
  };
  const store = createPipelineStore(
    client,
    options,
    undefined,
    undefined,
    undefined,
    undefined,
    {},
    undefined,
    undefined,
    lookbackFeed(),
  );
  await store.start();
  const sent = startPipeline.mock.calls[0] as unknown as [PipelineOptions];
  return sent[0];
}

describe('the params layer of a Discover start', () => {
  it('look-back on: the defaults, with the settings written out', () => {
    expect(
      runParamsLayer({
        lookback: true,
        factorSettle: false,
        visitMode: 'fixed',
        flatField: true,
        finalSettleLevel: 'thorough',
      }),
    ).toEqual({
      lookback: { enabled: true },
      discover: { visit: { mode: 'fixed' } },
      flat_field: { enabled: true },
      settle: { final: { level: 'thorough' } },
    });
  });

  it('look-back off drops the cluster replay and the merge guard it runs with', () => {
    const l = runParamsLayer({
      lookback: false,
      factorSettle: false,
      visitMode: 'auto',
      flatField: false,
    });
    expect(l.lookback).toEqual({ enabled: false });
    expect(l.discover).toEqual({
      visit: { mode: 'auto' },
      cluster: { update: 'off' },
      merge: { guard_min_sep_d: null },
    });
  });

  it("a live stream's settle on factors runs the replay of `settle.on_factors`", () => {
    const l = runParamsLayer({
      lookback: false,
      factorSettle: true,
      visitMode: 'fixed',
      flatField: true,
    });
    expect(l.discover?.cluster).toEqual({ update: 'refine' });
    expect(l.discover?.merge).toEqual({ guard_min_sep_d: null });
  });

  it('the settings win over the base layer; the rest of it is kept', () => {
    const base: ParamsLayer = {
      lookback: { enabled: false, rate: 3 },
      scales: { cell_diameter_px: 16 },
    };
    const l = runParamsLayer({
      lookback: true,
      factorSettle: false,
      visitMode: 'fixed',
      flatField: true,
      base,
    });
    expect(l.lookback).toEqual({ enabled: true, rate: 3 });
    expect(l.scales).toEqual({ cell_diameter_px: 16 });
  });
});

describe("the app's params resolved", () => {
  it.each([20, 30])(
    'equal the golden engine view at %i fps with the default settings',
    async (fps) => {
      const o = await startOptions();
      const json = resolveRunParams(o.paramsLayer!, { fps, width: 600, height: 600 });
      expect(runParams(json).engine).toEqual(golden(fps));
      expect(JSON.parse(ResolvedParams.fromJson(json).engineJson())).toEqual(golden(fps));
    },
  );

  it('a recording without a frame rate resolves at the declared fallback', () => {
    const json = resolveRunParams({}, { fps: null, width: 32, height: 32 });
    expect(runParams(json).context.fps).toBe(20);
    expect(runParams(json).engine.fps).toBe(20);
  });

  it('a key that is not a params field is refused with its pointer', () => {
    expect(() =>
      resolveRunParams({ discover: { acept_z: 4 } } as ParamsLayer, {
        fps: 20,
        width: 32,
        height: 32,
      }),
    ).toThrow(/\/discover\/acept_z/);
  });
});

describe('a params field set in the app reaches the engine', () => {
  it('cell_diameter_px: store -> frame worker -> worker inits -> WASM objects', async () => {
    // The app: a layer under the settings (what a config file or the pre-run sheet will set).
    const options = await startOptions({ paramsLayer: { scales: { cell_diameter_px: 16 } } });
    expect(options.paramsLayer?.scales?.cell_diameter_px).toBe(16);

    // The frame worker's stage A resolves it once; stage C's fast loop sends the slow loop's init.
    const sent: FastToSlow[] = [];
    const backend: TraceBackend = {
      libraryFromBytes: () => {
        throw new Error('no library in this test');
      },
      newEngine: () => {
        throw new Error('no library in this test');
      },
    };
    let fast: FastLoop | null = null;
    const movie = blobMovie({
      width: 48,
      height: 40,
      frames: 64,
      seed: 3,
      blobs: 6,
      frame: (f, blobs) => (y, x) =>
        20 +
        blobs.reduce(
          (v, b) => v + b.a * Math.exp(-((y - b.y) ** 2 + (x - b.x) ** 2) / 18) * (1 + (f % 5) / 5),
          0,
        ),
    });
    const chain = new StageChain(
      movie,
      { ...options, calibrationFrames: 16, motionWarmupFrames: 16, previewMaxSide: 32 },
      {
        fastLoop: (setup) => {
          fast = new FastLoop(
            {
              ...fastLoopOptions(setup, { session: 1, discover: true }, [], true),
              qc: false,
              startFrame: 8,
            },
            {
              postMessage(m: FastToSlow) {
                sent.push(m);
                if (m.type === 'frames')
                  fast!.handleSlow({
                    type: 'ack',
                    session: 1,
                    frames: m.frames,
                    start: m.start,
                    count: m.count,
                    observed: m.count,
                  });
              },
            },
            backend,
          );
          return fast;
        },
      },
    );
    for (;;) if ((await chain.step()).kind === 'done') break;
    chain.dispose();

    // What every worker is sent: the plan (motion, flat field, look-back, compress, Extract)
    // and the slow loop's init (slow and visit workers) carry the same resolved params.
    const init = sent.find((m) => m.type === 'init') as (SlowInit & { type: 'init' }) | undefined;
    expect(init).toBeDefined();
    expect(init!.params).toBe(chain.plan.params);
    const engine = JSON.parse(ResolvedParams.fromJson(init!.params).engineJson()) as {
      cell_diameter: { px: number };
      preprocess: { flatten_cell_diameter_px: number; flatten_sigma_px: number };
      slow_loop: { cell_diameter_px: number };
    };
    expect(engine.cell_diameter.px).toBe(16);
    expect(engine.preprocess.flatten_cell_diameter_px).toBe(16);
    expect(engine.preprocess.flatten_sigma_px).toBe(32);
    expect(engine.slow_loop.cell_diameter_px).toBe(16);

    // The WASM objects of those workers build from it.
    const p = paramsHandle(init!.params);
    const loop = buildSlowLoop(SlowLoop, init!);
    const visit = buildSlowLoop(VisitWorker, init!);
    const motion = new MotionCorrector(48, 40, p);
    const qc = new QcMonitor(48, 40, init!.fov, init!.noise, p);
    for (const o of [loop, visit, motion, qc]) o.free();
  });
});
