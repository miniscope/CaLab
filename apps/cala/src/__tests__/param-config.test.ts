// @vitest-environment node
/**
 * Config files (`calab-config`) and the pre-run sheet's params: load, validation, unknown keys,
 * save with sources, the bound settings, and the µm cell diameter against the engine's own rule.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createRoot } from 'solid-js';
import { isRefusal, readConfig, type LoadedConfig } from '../lib/config-file.ts';
import { createParamLayers, diameterPlan, runLayer, umPerPx } from '../lib/param-layers.ts';
import { resolveRunParams } from '../lib/params-handle.ts';
import { runParams, type ParamsLayer } from '../lib/run-params.ts';
import { initTestWasm } from './wasm-test.ts';

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
});
