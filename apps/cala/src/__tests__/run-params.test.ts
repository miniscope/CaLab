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
import { createPipelineStore, type PipelineStore } from '../lib/pipeline-store.ts';
import { fastLoopOptions } from '../lib/run-cells.ts';
import { runParams, runParamsLayer, type ParamsLayer } from '../lib/run-params.ts';
import { buildSlowLoop } from '../lib/slow-runner.ts';
import { StageChain } from '../lib/stage-chain.ts';
import type { FastToSlow, SlowInit } from '../workers/slow-types.ts';
import { blobMovie } from './blob-movie.ts';
import { testPlan } from './params-fixtures.ts';
import { initTestWasm } from './wasm-test.ts';
import { getAt, schemaFields, setAt, type ParamField } from '@calab/core';
import { runLayer } from '../lib/param-layers.ts';
import { PARAMS_SCHEMA } from '../lib/config-file.ts';
import { LOOKBACK_OFF_SETS, SET_AT_START, sheetShows } from '../lib/sheet-fields.ts';

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
async function startOptions(
  options: PipelineOptions = {},
  prepare?: (store: PipelineStore) => void,
): Promise<PipelineOptions> {
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
  prepare?.(store);
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

  it('carries Extract after Discover as set: off makes a Discover-only run', () => {
    const l = (extract?: boolean) =>
      runParamsLayer({
        lookback: true,
        factorSettle: false,
        visitMode: 'fixed',
        flatField: true,
        ...(extract !== undefined ? { extract } : {}),
      }).stages;
    expect(l(false)).toEqual({ extract: false });
    expect(l(true)).toEqual({ extract: true });
    expect(l()).toBeUndefined();
    // The setting wins over a layer under it, as every setting does.
    expect(
      runParamsLayer({
        lookback: true,
        factorSettle: false,
        visitMode: 'fixed',
        flatField: true,
        extract: true,
        base: { stages: { extract: false } },
      }).stages,
    ).toEqual({ extract: true });
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

  it.each([
    ['look-back on', true, false, 'all', 0.6],
    ['look-back off', false, false, 'off', null],
    ['a settle on factors', false, true, 'refine', null],
  ] as const)(
    '%s: the slow loop runs the cluster replay and merge guard of its shape',
    (_, lookback, factorSettle, update, guard) => {
      const layer = runParamsLayer({ lookback, factorSettle, visitMode: 'fixed', flatField: true });
      const e = runParams(resolveRunParams(layer, { fps: 20, width: 64, height: 64 })).engine;
      expect(e.slow_loop.joint_update).toBe(update);
      expect(e.slow_loop.joint_sign_rule).toBe('all');
      expect(e.slow_loop.merge_guard_min_sep).toBe(guard);
      expect(e.lookback.enabled).toBe(lookback);
    },
  );

  it('the look-back workers get the run params of a look-back run', async () => {
    const feed = lookbackFeed();
    const startPipeline = vi.fn(async () => testPlan(100));
    const store = createPipelineStore(
      { startPipeline, stepPipeline: () => new Promise(() => {}), stopPipeline: async () => {} },
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      {},
      undefined,
      undefined,
      feed,
    );
    await store.start();
    expect(feed.params).toHaveBeenCalledWith(expect.any(Number), testPlan(100).params);
  });

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

/** A valid value of `f` other than its default. */
function nonDefault(f: ParamField): unknown {
  if (f.kind === 'boolean') return f.default !== true;
  if (f.kind === 'enum') return f.choices!.find((c) => c.value !== f.default)!.value;
  const min = f.minimum ?? 0;
  const max = f.maximum ?? min + 100;
  const d = typeof f.default === 'number' ? f.default : null;
  let v = d === null ? min + (max - min) / 4 : d < max ? d + (max - d) / 2 : (min + d) / 2;
  if (f.kind === 'integer') v = Math.round(v);
  return v;
}

describe('every field the pre-run sheet renders reaches the run', () => {
  it('a value set in the sheet is in the params the run resolves', async () => {
    // Extract after Discover is shown (on, held) but set at each start: every run Extracts.
    const fields = schemaFields(PARAMS_SCHEMA).filter(
      (f) =>
        (f.level === 'main' || f.level === 'advanced') &&
        sheetShows(f, true) &&
        !SET_AT_START[f.pointer],
    );
    expect(fields).toHaveLength(30);
    for (const f of fields) {
      // A µm diameter needs the optics; 30 µm at 2 µm per pixel is 15 px.
      const v = f.pointer === '/scales/expected_cell_diameter_um' ? 30 : nonDefault(f);
      const options = await startOptions({}, (store) => {
        if (f.pointer === '/scales/expected_cell_diameter_um') {
          store.params.set('/optics/sensor_pixel_um', 2);
          store.params.set('/optics/magnification', 1);
        }
        store.params.set(f.pointer, v);
      });
      const run = runParams(
        resolveRunParams(options.paramsLayer ?? {}, { fps: 20, width: 600, height: 600 }),
      );
      expect(getAt(run.params, f.pointer), f.pointer).toEqual(v);
      if (f.pointer === '/scales/expected_cell_diameter_um')
        expect(run.engine.cell_diameter).toEqual({ px: 15, source: 'optics', um_per_px: 2 });
    }
  });
});

describe('every field a config file sets reaches the run or is reported as replaced', () => {
  it("is in the resolved params, or the app's own settings set it and the record says so", async () => {
    const fields = schemaFields(PARAMS_SCHEMA).filter(
      (f) => f.level !== 'internal' && f.kind !== 'other' && !f.widget,
    );
    for (const f of fields) {
      const v = f.pointer === '/scales/expected_cell_diameter_um' ? 30 : nonDefault(f);
      let store: PipelineStore | undefined;
      const options = await startOptions({}, (s) => {
        store = s;
        const layer: Record<string, unknown> = {};
        let l = setAt(layer, f.pointer, v);
        if (f.pointer === '/scales/expected_cell_diameter_um')
          l = setAt(setAt(l, '/optics/sensor_pixel_um', 2), '/optics/magnification', 1);
        s.params.load({
          name: 'c.json',
          layer: l as ParamsLayer,
          unknown: [],
          ignored: {},
          kind: 'config',
        });
      });
      const run = runParams(
        resolveRunParams(options.paramsLayer ?? {}, { fps: 20, width: 600, height: 600 }),
      );
      const req = store!.runRequest()!;
      if (req.overridden[f.pointer]) {
        // Replaced: named in the sheet when the file loads, and in the record; not a source.
        const lookbackOff = run.params.lookback.enabled === false;
        expect(
          f.pointer in SET_AT_START || (lookbackOff && LOOKBACK_OFF_SETS.includes(f.pointer)),
          f.pointer,
        ).toBe(true);
        expect(req.sources[f.pointer]).toBeUndefined();
      } else {
        expect(getAt(run.params, f.pointer), f.pointer).toEqual(v);
        expect(req.sources[f.pointer], f.pointer).toBe('file:c.json');
      }
      // The bound settings (e.g. Extract after Discover) are page-wide: back to the defaults.
      store!.params.clear();
    }
  });
});

describe('a µm cell diameter is never replaced by the default pixels', () => {
  it('without the optics the start refuses, and no run starts', async () => {
    const startPipeline = vi.fn(async () => testPlan(100));
    const store = createPipelineStore(
      {
        startPipeline,
        stepPipeline: () => new Promise(() => {}),
        stopPipeline: async () => {},
        subscribeFlatField: () => () => {},
      },
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      {},
      undefined,
      undefined,
      lookbackFeed(),
    );
    store.params.set('/scales/expected_cell_diameter_um', 30);
    await store.start();
    expect(startPipeline).not.toHaveBeenCalled();
    expect(store.status()).toBe('error');
    expect(store.error()).toMatch(/sensor pixel size/);
    expect(runLayer(store.params.requested()).scales).toEqual({
      expected_cell_diameter_um: 30,
      cell_diameter_px: null,
    });
  });
});

describe('the run file goes to disk before the first frame', () => {
  const make = () => {
    const startPipeline = vi.fn(async () => testPlan(100));
    const stepPipeline = vi.fn(() => new Promise<never>(() => {}));
    const store = createPipelineStore(
      {
        startPipeline,
        stepPipeline,
        stopPipeline: async () => {},
        subscribeFlatField: () => () => {},
      },
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      {},
      undefined,
      undefined,
      lookbackFeed(),
    );
    return { store, startPipeline, stepPipeline };
  };

  it('awaits the hook once the params are resolved, and pumps no frame until it is done', async () => {
    const { store, startPipeline, stepPipeline } = make();
    let release!: () => void;
    const seen: { params: boolean; steps: number; status: string }[] = [];
    store.setBeforeFrames(async () => {
      seen.push({
        params: store.runRequest() !== null,
        steps: stepPipeline.mock.calls.length,
        status: store.status(),
      });
      await new Promise<void>((r) => (release = r));
    });
    const started = store.start();
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(startPipeline).toHaveBeenCalledTimes(1);
    expect(seen[0]).toEqual({ params: true, steps: 0, status: 'starting' });
    expect(stepPipeline).not.toHaveBeenCalled();
    release();
    await started;
    expect(store.status()).toBe('running');
    await vi.waitFor(() => expect(stepPipeline).toHaveBeenCalled());
  });

  it('a failed hook stops the start: no frame is read', async () => {
    const { store, stepPipeline } = make();
    store.setBeforeFrames(async () => {
      throw new Error('the run folder could not be written');
    });
    await store.start();
    expect(store.status()).toBe('error');
    expect(store.error()).toContain('could not be written');
    expect(stepPipeline).not.toHaveBeenCalled();
    // Without a hook, frames start at once.
    store.setBeforeFrames(null);
    await store.start();
    expect(store.status()).toBe('running');
  });
});
