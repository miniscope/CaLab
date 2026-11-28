// @vitest-environment node
/**
 * Config files (`calab-config`) and the pre-run sheet's params: load, validation, unknown keys,
 * save with sources, the bound settings, and the µm cell diameter against the engine's own rule.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createRoot } from 'solid-js';
import {
  derivedSettings,
  isRefusal,
  readConfig,
  readConfigFile,
  readConfigJson,
  runConfigText,
  type LoadedConfig,
} from '../lib/config-file.ts';
import { createParamLayers, diameterPlan, runLayer, umPerPx } from '../lib/param-layers.ts';
import { resolveRunParams } from '../lib/params-handle.ts';
import { runParams, runParamsLayer, type ParamsLayer } from '../lib/run-params.ts';
import { extractAfterDiscover, setExtractAfterDiscover } from '../lib/run-stages.ts';
import { SET_AT_START } from '../lib/sheet-fields.ts';
import { initTestWasm } from './wasm-test.ts';
import { writeNpy, zipFiles } from '@calab/io';

/** A minimal export: `meta_json.npy` holding `meta` (uint8 JSON bytes), stored in a zip. */
async function npzWithMeta(meta: unknown): Promise<File> {
  const bytes = new TextEncoder().encode(JSON.stringify(meta));
  const npy = new Uint8Array(writeNpy(bytes, [bytes.length]));
  const zip = zipFiles({ 'meta_json.npy': npy }, { level: 0 });
  return new File([zip], 'cala-export.npz');
}

beforeAll(initTestWasm);

const EXAMPLE = resolve(import.meta.dirname, '../../docs/example-config.json');

function loaded(text: string, name = 'a.json'): LoadedConfig {
  const r = readConfig(text, name);
  if (isRefusal(r)) throw new Error(r.message);
  return r;
}

/** The engine's resolution of `layer` on a 600 px wide frame at 20 fps. */
const engineOf = (layer: ParamsLayer, width = 600) =>
  runParams(resolveRunParams(layer, { fps: 20, width, height: 600 }));

describe('readConfig', () => {
  it('reads a calab-config with comments; missing keys keep their defaults', () => {
    const c = loaded(`{
      // a partial config
      "format": "calab-config", "version": 1, "app": "cala", "params_version": 1,
      "note": "V4 https://example.org",
      "params": { "scales": { "cell_diameter_px": 16 } }
    }`);
    expect(c.kind).toBe('config');
    expect(c.layer).toEqual({ scales: { cell_diameter_px: 16 } });
    expect(c.note).toBe('V4 https://example.org');
    expect(c.unknown).toEqual([]);
  });

  it('warns about unknown keys, keeps them aside, and drops them from the layer', () => {
    const c = loaded(
      JSON.stringify({
        format: 'calab-config',
        params: { discover: { acept_z: 4, accept_z: 6 }, nope: { x: 1 } },
      }),
    );
    expect(c.unknown).toEqual([
      { pointer: '/discover/acept_z', suggestion: 'accept_z' },
      { pointer: '/nope' },
    ]);
    expect(c.layer).toEqual({ discover: { accept_z: 6 } });
    expect(c.ignored).toEqual({ discover: { acept_z: 4 }, nope: { x: 1 } });
  });

  it('refuses values outside the schema, naming each', () => {
    const r = readConfig(
      JSON.stringify({ params: { scales: { cell_diameter_px: 2 }, lookback: { enabled: 1 } } }),
      'bad.json',
    );
    expect(isRefusal(r)).toBe(true);
    if (!isRefusal(r)) return;
    expect(r.errors.map((e) => e.pointer)).toEqual([
      '/scales/cell_diameter_px',
      '/lookback/enabled',
    ]);
  });

  it('refuses other formats, other apps, newer versions and files with no settings', () => {
    const msg = (t: string) => {
      const r = readConfig(t, 'x.json');
      return isRefusal(r) ? r.message : 'loaded';
    };
    expect(msg('{"format": "cala-run"}')).toMatch(/not a config file/);
    expect(msg('{"format": "calab-config", "app": "cadecon"}')).toMatch(/cadecon/);
    expect(msg('{"format": "calab-config", "version": 2}')).toMatch(/newer/);
    expect(msg('{"format": "calab-config", "params_version": 2, "params": {}}')).toMatch(
      /version 2/,
    );
    expect(msg('{"hello": 1}')).toMatch(/No cala settings/);
    expect(msg('not json')).toMatch(/Not JSON/);
  });

  it("takes a run file's request and a bare params object (a qc_eval --params file)", () => {
    const run = loaded(
      JSON.stringify({
        format: 'calab-run',
        config: { requested: { scales: { cell_diameter_px: 12 } } },
      }),
    );
    expect(run.kind).toBe('run');
    expect(run.layer).toEqual({ scales: { cell_diameter_px: 12 } });
    const bare = loaded(JSON.stringify({ params_version: 1, motion: { template_tau_s: 30 } }));
    expect(bare.kind).toBe('params');
    expect(bare.layer).toEqual({ motion: { template_tau_s: 30 } });
  });

  it("the docs' example loads and resolves to its 16 px through the optics", () => {
    const c = loaded(readFileSync(EXAMPLE, 'utf8'), 'example-config.json');
    expect(c.unknown).toEqual([]);
    const e = engineOf(runLayer(c.layer)).engine;
    expect(e.cell_diameter).toEqual({ px: 16, source: 'optics', um_per_px: 2 });
    expect(e.preprocess.flatten_cell_diameter_px).toBe(16);
  });
});

describe('the cell diameter', () => {
  it('matches the engine: µm through the optics, binning given or from the sensor width', () => {
    const cases: [ParamsLayer, number][] = [
      [{ optics: { sensor_pixel_um: 2.2, magnification: 3.1 } }, 600],
      [{ optics: { sensor_pixel_um: 4.8, magnification: 2.4, binning: 2 } }, 600],
      [{ optics: { sensor_pixel_um: 2.2, magnification: 3.1, sensor_width_px: 1280 } }, 600],
      [{ optics: { sensor_pixel_um: 2.2, magnification: 3.1, sensor_width_px: 1280 } }, 320],
      [{ optics: { sensor_pixel_um: 1.1, magnification: 0.7, sensor_width_px: 500 } }, 600],
    ];
    for (const [optics, width] of cases) {
      const layer = runLayer({ ...optics, scales: { expected_cell_diameter_um: 13.7 } });
      const e = engineOf(layer, width).engine.cell_diameter;
      const plan = diameterPlan(layer, width);
      expect(plan.source).toBe('optics');
      expect(plan.px).toBe(e.px);
      expect(plan.umPerPx).toBe(e.um_per_px);
      expect(umPerPx(engineOf(layer, width).params.optics, width)).toBe(e.um_per_px);
    }
  });

  it('defaults to 10 px, and a pixel diameter overrides the µm one', () => {
    expect(runLayer({})).toEqual({});
    expect(diameterPlan({}, 600)).toMatchObject({ source: 'px', px: 10, issues: [] });
    const both: ParamsLayer = {
      optics: { sensor_pixel_um: 2, magnification: 1 },
      scales: { expected_cell_diameter_um: 30, cell_diameter_px: 12 },
    };
    expect(runLayer(both)).toEqual(both);
    expect(diameterPlan(both, 600)).toMatchObject({ source: 'px', px: 12, overridesUm: true });
    expect(engineOf(both).engine.cell_diameter.px).toBe(12);
  });

  it('a µm diameter without the optics, or out of range in pixels, is an issue', () => {
    const noOptics: ParamsLayer = { scales: { expected_cell_diameter_um: 30 } };
    expect(runLayer(noOptics)).toEqual({
      scales: { expected_cell_diameter_um: 30, cell_diameter_px: null },
    });
    expect(() => engineOf(runLayer(noOptics))).toThrow();
    expect(diameterPlan(noOptics, 600).issues[0].message).toMatch(/sensor pixel size/);
    const big: ParamsLayer = {
      optics: { sensor_pixel_um: 1, magnification: 1 },
      scales: { expected_cell_diameter_um: 100 },
    };
    expect(diameterPlan(big, 600).issues[0].message).toMatch(/100\.0 px/);
    const nothing: ParamsLayer = { scales: { cell_diameter_px: null } };
    expect(diameterPlan(nothing, 600).issues[0].message).toMatch(/µm or in pixels/);
  });
});

describe('createParamLayers', () => {
  it('layers a file under the edits, with sources, and saves only what was asked', () => {
    createRoot((dispose) => {
      const p = createParamLayers();
      expect(p.requested()).toEqual({});
      expect(p.source('/scales/cell_diameter_px')).toBe('default');
      expect(p.value('/scales/cell_diameter_px')).toBe(10);
      p.load(
        loaded(
          JSON.stringify({
            format: 'calab-config',
            params: { scales: { cell_diameter_px: 16 }, motion: { template_tau_s: 30 }, x: 1 },
          }),
          'v4.json',
        ),
      );
      p.set('/motion/template_tau_s', 40);
      expect(p.value('/scales/cell_diameter_px')).toBe(16);
      expect(p.sources()).toEqual({
        '/scales/cell_diameter_px': 'file:v4.json',
        '/motion/template_tau_s': 'ui',
      });
      const saved = JSON.parse(p.saveText());
      expect(saved).toEqual({
        format: 'calab-config',
        version: 1,
        app: 'cala',
        params_version: 1,
        params: { scales: { cell_diameter_px: 16 }, motion: { template_tau_s: 40 }, x: 1 },
        sources: { '/scales/cell_diameter_px': 'file:v4.json', '/motion/template_tau_s': 'ui' },
      });
      // A saved file loads back to the same request.
      const again = createParamLayers();
      again.load(loaded(p.saveText(), 'again.json'));
      expect(again.requested()).toEqual(p.requested());
      p.reset('/scales/cell_diameter_px');
      expect(p.value('/scales/cell_diameter_px')).toBe(10);
      expect(p.source('/scales/cell_diameter_px')).toBe('default');
      p.clear();
      expect(p.requested()).toEqual({});
      dispose();
    });
  });

  it('writes bound fields through to their setting and tags them by where they came from', () => {
    createRoot((dispose) => {
      let on = true;
      const lookback = () => on;
      const setLookback = (v: boolean) => (on = v);
      const p = createParamLayers({
        '/lookback/enabled': { get: lookback, set: (v) => setLookback(v === true) },
      });
      p.load(loaded('{"params": {"lookback": {"enabled": false}}}', 'f.json'));
      expect(lookback()).toBe(false);
      expect(p.source('/lookback/enabled')).toBe('file:f.json');
      expect(p.requested()).toEqual({ lookback: { enabled: false } });
      // Changed elsewhere in the app: the value is the setting's, set by the user.
      setLookback(true);
      expect(p.source('/lookback/enabled')).toBe('default');
      expect(p.requested()).toEqual({});
      p.set('/lookback/enabled', false);
      expect(lookback()).toBe(false);
      expect(p.source('/lookback/enabled')).toBe('ui');
      p.clear();
      expect(lookback()).toBe(true);
      dispose();
    });
  });

  it('layers the project, the step and the stream under a file and the edits', () => {
    createRoot((dispose) => {
      let on = true;
      const p = createParamLayers({
        '/lookback/enabled': { get: () => on, set: (v) => (on = v === true) },
      });
      // No base: no project values.
      p.setBase([]);
      expect(p.requested()).toEqual({});
      expect(on).toBe(true);
      p.setBase([
        {
          tag: 'project',
          layer: { scales: { cell_diameter_px: 16 }, motion: { template_tau_s: 30 } },
        },
        { tag: 'step', layer: { motion: { template_tau_s: 35 } } },
        { tag: 'stream', layer: { motion: { max_shift_px: 9 }, lookback: { enabled: false } } },
      ]);
      // A bound setting follows the layers.
      expect(on).toBe(false);
      expect(p.sources()).toEqual({
        '/scales/cell_diameter_px': 'project',
        '/motion/template_tau_s': 'step',
        '/motion/max_shift_px': 'stream',
        '/lookback/enabled': 'stream',
      });
      expect(p.requested()).toEqual({
        scales: { cell_diameter_px: 16 },
        motion: { template_tau_s: 35, max_shift_px: 9 },
        lookback: { enabled: false },
      });
      // A file and an edit go over them.
      p.load(loaded('{"params": {"motion": {"template_tau_s": 50}}}', 'f.json'));
      p.set('/scales/cell_diameter_px', 12);
      expect(p.source('/motion/template_tau_s')).toBe('file:f.json');
      expect(p.source('/scales/cell_diameter_px')).toBe('ui');
      expect(p.edits()).toEqual({
        scales: { cell_diameter_px: 12 },
        motion: { template_tau_s: 50 },
      });
      // Reset of a field the project sets: the default, pinned over it.
      p.reset('/scales/cell_diameter_px');
      expect(p.value('/scales/cell_diameter_px')).toBe(10);
      expect(p.source('/scales/cell_diameter_px')).toBe('ui');
      // Clear: back to the layers, not the defaults.
      p.clear();
      expect(p.source('/scales/cell_diameter_px')).toBe('project');
      expect(on).toBe(false);
      // Changed elsewhere in the app, a bound setting is not taken back by new layers.
      on = true;
      p.setBase([{ tag: 'project', layer: { motion: { template_tau_s: 30 } } }]);
      expect(on).toBe(true);
      // Saved into a layer: the edits go, the bound setting stays as it is.
      p.set('/lookback/enabled', false);
      p.setBase([
        { tag: 'project', layer: { motion: { template_tau_s: 30 }, lookback: { enabled: false } } },
      ]);
      p.dropEdits();
      expect(on).toBe(false);
      expect(p.source('/lookback/enabled')).toBe('project');
      // A base removed: a bound setting that followed it goes back to its default.
      p.setBase([]);
      expect(on).toBe(true);
      dispose();
    });
  });
});

describe('layer order', () => {
  it('the stream beats the step, the step beats the project, a file and an edit beat them all', () => {
    createRoot((dispose) => {
      const p = createParamLayers();
      const d = '/scales/cell_diameter_px';
      p.setBase([
        { tag: 'project', layer: { scales: { cell_diameter_px: 16 } } },
        { tag: 'step', layer: { scales: { cell_diameter_px: 15 } } },
        { tag: 'stream', layer: { scales: { cell_diameter_px: 14 } } },
      ]);
      expect([p.value(d), p.source(d)]).toEqual([14, 'stream']);
      expect(engineOf(p.runLayer()).engine.cell_diameter.px).toBe(14);
      p.setBase([
        { tag: 'project', layer: { scales: { cell_diameter_px: 16 } } },
        { tag: 'step', layer: { scales: { cell_diameter_px: 15 } } },
      ]);
      expect([p.value(d), p.source(d)]).toEqual([15, 'step']);
      p.load(loaded('{"params": {"scales": {"cell_diameter_px": 13}}}', 'f.json'));
      expect([p.value(d), p.source(d)]).toEqual([13, 'file:f.json']);
      p.set(d, 12);
      expect([p.value(d), p.source(d)]).toEqual([12, 'ui']);
      dispose();
    });
  });
});

describe('a config from a past run', () => {
  const run = {
    format: 'calab-run',
    run: { id: 'r1' },
    config: {
      params_version: 1,
      requested: { scales: { cell_diameter_px: 16 } },
      sources: { '/scales/cell_diameter_px': 'project' },
    },
    derived: {
      '/time/fps': { value: 30.02, source: 'data' },
      '/scales/cell_diameter_px': { seed: 16, value: 12.4, source: 'data' },
      '/not/a/setting': { value: 1 },
      '/motion/template_tau_s': { value: 'x' },
    },
  };

  it('takes what the run asked for; the data values only when pinned', () => {
    expect(derivedSettings(run)).toEqual({
      '/time/fps_override': 30.02,
      '/scales/cell_diameter_px': 12.4,
    });
    const asked = readConfigJson(run, 'cala-export.npz') as LoadedConfig;
    expect(asked.kind).toBe('run');
    expect(asked.layer).toEqual({ scales: { cell_diameter_px: 16 } });
    expect(asked.derived).toBeDefined();
    expect(asked.pinned).toBeUndefined();
    const pinned = readConfigJson(run, 'cala-export.npz', { pinDerived: true }) as LoadedConfig;
    expect(pinned.layer).toEqual({
      scales: { cell_diameter_px: 12.4 },
      time: { fps_override: 30.02 },
    });
    expect(pinned.pinned).toEqual(['/time/fps_override', '/scales/cell_diameter_px']);
    // The pinned layer resolves: the frame rate is the run's, not the recording's.
    expect(engineOf(runLayer(pinned.layer)).params.time.fps_override).toBe(30.02);
  });

  it('refuses a run file of another params version (read from its config)', () => {
    const r = readConfigJson({ ...run, config: { ...run.config, params_version: 7 } }, 'x');
    expect(isRefusal(r) && r.message).toContain('Params version 7');
  });

  it("writes a run's request as a config file, with the run's sources", () => {
    const text = runConfigText(run, 'note')!;
    expect(JSON.parse(text)).toMatchObject({
      format: 'calab-config',
      note: 'note',
      params: { scales: { cell_diameter_px: 16 } },
      sources: { '/scales/cell_diameter_px': 'project' },
    });
    expect(runConfigText({ format: 'other' })).toBeNull();
  });

  it('reads it from an export (.npz): its meta_json.run', async () => {
    const npz = await npzWithMeta({ format_version: 8, run });
    const r = (await readConfigFile(npz)) as LoadedConfig;
    expect(r.name).toBe('cala-export.npz');
    expect(r.layer).toEqual({ scales: { cell_diameter_px: 16 } });
    const old = await readConfigFile(await npzWithMeta({ format_version: 7 }));
    expect(isRefusal(old) && old.message).toContain('older than the run file');
    const notZip = await readConfigFile(new File(['abc'], 'x.npz'));
    expect(isRefusal(notZip) && notZip.message).toContain('not a cala export');
    const json = await readConfigFile(new File([JSON.stringify(run)], 'calab-run.json'));
    expect(isRefusal(json)).toBe(false);
  });
});

describe('Extract after Discover (a Discover-only run)', () => {
  it('round-trips through a config file and reaches the resolved params as set', () => {
    createRoot((dispose) => {
      const binding = {
        '/stages/extract': {
          get: () => extractAfterDiscover(),
          set: (v: unknown) => setExtractAfterDiscover(v === true),
        },
      };
      const p = createParamLayers(binding);
      expect(p.value('/stages/extract')).toBe(true);
      p.set('/stages/extract', false);
      expect(extractAfterDiscover()).toBe(false);
      const text = p.saveText();
      expect(JSON.parse(text).params).toEqual({ stages: { extract: false } });
      // Back to the default, then the saved file loads the choice back.
      p.clear();
      expect(extractAfterDiscover()).toBe(true);
      const again = createParamLayers(binding);
      again.load(loaded(text, 'footprints-only.json'));
      expect(extractAfterDiscover()).toBe(false);
      expect(again.source('/stages/extract')).toBe('file:footprints-only.json');
      // A start sends the setting; nothing overrides it and the engine resolves it.
      const layer = runParamsLayer({
        lookback: true,
        factorSettle: false,
        visitMode: 'fixed',
        flatField: true,
        extract: extractAfterDiscover(),
        base: again.runLayer(),
      });
      expect(again.overridden(layer)).toEqual({});
      expect(SET_AT_START['/stages/extract']).toBeUndefined();
      expect(engineOf(layer).params.stages.extract).toBe(false);
      // A project default of off is followed the same way.
      again.clear();
      again.setBase([{ tag: 'project', layer: { stages: { extract: false } } }]);
      expect(extractAfterDiscover()).toBe(false);
      expect(again.source('/stages/extract')).toBe('project');
      again.setBase([]);
      expect(extractAfterDiscover()).toBe(true);
      dispose();
    });
  });
});
