/**
 * The params a user asks for before a run: a loaded config file under the edits made in the
 * pre-run sheet, with the source of each value. The request persists across recordings and is
 * the base layer of every Discover start (single, multi-session and live).
 *
 * Some fields have a setting elsewhere in the app that the run reads directly (look-back, the
 * Final settle level, Find new cells, Extract after Discover). For those, the form and a loaded
 * file write through to that setting (`Bindings`), so there is one value, and the layers only keep
 * where it came from.
 *
 * The cell diameter: `scales.cell_diameter_px` (default 10) overrides the diameter derived from
 * `scales.expected_cell_diameter_um` through the optics. When a user asks for a µm diameter and
 * nothing they set asks for a pixel diameter, the run's layer clears the pixel default so the µm
 * diameter is used (`runLayer`); without the optics the engine then refuses the run.
 */
import { createSignal } from 'solid-js';
import {
  deleteAt,
  getAt,
  layerEntries,
  mergeLayer,
  setAt,
  type ParamIssue,
  type UnknownParam,
} from '@calab/core';
import type { CalaParams } from '../params/cala-params.d.ts';
import { schemaDefaults } from '../params/schema.ts';
import { PARAMS_SCHEMA, configText, type LoadedConfig, type RequestSource } from './config-file.ts';
import type { ParamsLayer } from './run-params.ts';

/** A setting the app keeps elsewhere, read and written through for one params field. */
export interface BoundSetting {
  get(): unknown;
  set(value: unknown): void;
}

/** JSON pointer → the app setting that holds that field. */
export type Bindings = Record<string, BoundSetting>;

/** Where a value comes from, as the form shows it. */
export type ParamSource = 'default' | RequestSource;

const DIAMETER_PX = '/scales/cell_diameter_px';
const DIAMETER_UM = '/scales/expected_cell_diameter_um';

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * µm per frame pixel at the sample: `sensor_pixel_um × binning ÷ magnification`, null when the
 * sensor pixel size or the magnification is unknown. Binning, when not given, is the sensor width
 * over the frame width (rounded, at least 1) when the sensor width is known, else 1. The same
 * expression as `um_per_px` in `crates/cala/src/params/resolve.rs` (a vitest checks the two agree).
 */
export function umPerPx(optics: CalaParams['optics'], frameWidth: number): number | null {
  const { sensor_pixel_um: pixel, magnification: mag } = optics;
  if (pixel == null || mag == null) return null;
  const binning =
    optics.binning != null
      ? optics.binning
      : optics.sensor_width_px != null && frameWidth > 0
        ? Math.max(1, Math.round(optics.sensor_width_px / frameWidth))
        : 1;
  return (pixel * binning) / mag;
}

/** How the run's cell diameter in pixels is found from a requested layer. */
export interface DiameterPlan {
  /** `optics`: the µm diameter through the optics; `px`: the pixel diameter (set or default). */
  source: 'optics' | 'px';
  /** The diameter, px (null when it cannot be found). */
  px: number | null;
  /** µm per frame pixel when the optics give it. */
  umPerPx: number | null;
  /** The pixel diameter is set and a µm diameter is also asked for: the pixels win. */
  overridesUm: boolean;
  /** Why the diameter cannot be found, or is out of range (empty: fine). */
  issues: ParamIssue[];
}

/** The cell diameter a requested layer gives on frames `frameWidth` px wide. */
export function diameterPlan(requested: ParamsLayer, frameWidth: number): DiameterPlan {
  const p = mergeLayer(
    schemaDefaults() as unknown as Record<string, unknown>,
    requested,
  ) as unknown as CalaParams;
  const per = umPerPx(p.optics, frameWidth);
  const um = p.scales.expected_cell_diameter_um ?? null;
  const pxAsked = getAt(requested, DIAMETER_PX);
  const issues: ParamIssue[] = [];
  if (typeof pxAsked === 'number' || (pxAsked === undefined && um === null)) {
    return {
      source: 'px',
      px: p.scales.cell_diameter_px ?? null,
      umPerPx: per,
      overridesUm: um !== null,
      issues,
    };
  }
  if (um === null) {
    issues.push({ pointer: DIAMETER_UM, message: 'Set the cell diameter in µm or in pixels.' });
    return { source: 'optics', px: null, umPerPx: per, overridesUm: false, issues };
  }
  if (per === null) {
    issues.push({
      pointer: DIAMETER_UM,
      message: 'Needs the sensor pixel size and the magnification to turn µm into pixels.',
    });
    return { source: 'optics', px: null, umPerPx: null, overridesUm: false, issues };
  }
  const px = um / per;
  const f = PARAMS_SCHEMA.$defs?.Scales?.properties?.cell_diameter_px;
  const min = f?.minimum ?? 0;
  const max = f?.maximum ?? Infinity;
  if (px < min || px > max) {
    issues.push({
      pointer: DIAMETER_UM,
      message: `That is ${px.toFixed(1)} px; the diameter must be ${min}–${max} px.`,
    });
  }
  return { source: 'optics', px, umPerPx: per, overridesUm: false, issues };
}

/**
 * `requested` as the run resolves it: the pixel default cleared when a µm diameter is asked for
 * and no pixel diameter is. A µm diameter is never silently replaced by the default pixels: with
 * the optics missing, `resolve` refuses the layer.
 */
export function runLayer(requested: ParamsLayer): ParamsLayer {
  const um = getAt(requested, DIAMETER_UM);
  if (typeof um !== 'number' || getAt(requested, DIAMETER_PX) !== undefined) return requested;
  return setAt(requested as Record<string, unknown>, DIAMETER_PX, null) as ParamsLayer;
}

/** The sheet's params: a loaded file, the edits over it, and where each value comes from. */
export function createParamLayers(bindings: Bindings = {}) {
  const [file, setFile] = createSignal<LoadedConfig | null>(null);
  const [ui, setUi] = createSignal<ParamsLayer>({});
  const defaults = schemaDefaults();
  const defaultAt = (ptr: string): unknown => getAt(defaults, ptr);

  /** The layered value and its tag (null: no layer sets it). */
  const layered = (ptr: string): { value: unknown; tag: RequestSource } | null => {
    const u = getAt(ui(), ptr);
    if (u !== undefined) return { value: u, tag: 'ui' };
    const f = file();
    const fv = f ? getAt(f.layer, ptr) : undefined;
    return f && fv !== undefined ? { value: fv, tag: `file:${f.name}` } : null;
  };

  function value(ptr: string): unknown {
    const b = bindings[ptr];
    if (b) return b.get();
    const l = layered(ptr);
    return l ? l.value : defaultAt(ptr);
  }

  function source(ptr: string): ParamSource {
    const b = bindings[ptr];
    const l = layered(ptr);
    if (b) {
      const v = b.get();
      if (l && same(l.value, v)) return l.tag;
      return same(v, defaultAt(ptr)) ? 'default' : 'ui';
    }
    return l ? l.tag : 'default';
  }

  function set(ptr: string, v: unknown): void {
    setUi((u) => setAt(u as Record<string, unknown>, ptr, v) as ParamsLayer);
    bindings[ptr]?.set(v);
  }

  function reset(ptr: string): void {
    setUi((u) => deleteAt(u as Record<string, unknown>, ptr) as ParamsLayer);
    const f = file();
    if (f && getAt(f.layer, ptr) !== undefined) {
      setFile({ ...f, layer: deleteAt(f.layer as Record<string, unknown>, ptr) as ParamsLayer });
    }
    bindings[ptr]?.set(defaultAt(ptr));
  }

  /** Use a loaded file: its values replace earlier edits of the same fields. */
  function load(cfg: LoadedConfig): void {
    // The outgoing file's bound settings that neither the new file nor an edit sets go back to
    // their defaults, like its other values.
    const prev = file();
    if (prev) {
      for (const ptr of layerEntries(PARAMS_SCHEMA, prev.layer).keys()) {
        if (bindings[ptr] && getAt(cfg.layer, ptr) === undefined && getAt(ui(), ptr) === undefined)
          bindings[ptr].set(defaultAt(ptr));
      }
    }
    let u = ui() as Record<string, unknown>;
    for (const [ptr, v] of layerEntries(PARAMS_SCHEMA, cfg.layer)) {
      u = deleteAt(u, ptr);
      bindings[ptr]?.set(v);
    }
    setUi(u as ParamsLayer);
    setFile(cfg);
  }

  /** Back to the defaults: no file, no edits. */
  function clear(): void {
    setFile(null);
    setUi({});
    for (const [ptr, b] of Object.entries(bindings)) b.set(defaultAt(ptr));
  }

  /** Every value asked for (file, then edits), with the bound settings that differ from default. */
  function requested(): ParamsLayer {
    let out = mergeLayer(
      (file()?.layer ?? {}) as Record<string, unknown>,
      ui() as Record<string, unknown>,
    );
    for (const [ptr, b] of Object.entries(bindings)) {
      out = source(ptr) === 'default' ? deleteAt(out, ptr) : setAt(out, ptr, b.get());
    }
    return out as ParamsLayer;
  }

  /** JSON pointer → source of every value in `requested`. */
  function sources(): Record<string, RequestSource> {
    const out: Record<string, RequestSource> = {};
    for (const ptr of layerEntries(PARAMS_SCHEMA, requested()).keys()) {
      const s = source(ptr);
      if (s !== 'default') out[ptr] = s;
    }
    return out;
  }

  /**
   * The requested values that `sent` (the layer a start sends) does not carry: the app's own
   * settings set those fields at each start. Pointer → the value asked for and the value used.
   */
  function overridden(sent: ParamsLayer): Record<string, { asked: unknown; used: unknown }> {
    const out: Record<string, { asked: unknown; used: unknown }> = {};
    for (const [ptr, asked] of layerEntries(PARAMS_SCHEMA, runLayer(requested()))) {
      const used = getAt(sent, ptr);
      if (!same(asked, used))
        out[ptr] = { asked, used: used === undefined ? defaultAt(ptr) : used };
    }
    return out;
  }

  return {
    file,
    value,
    overridden,
    source,
    set,
    reset,
    load,
    clear,
    requested,
    sources,
    /** The layer a run resolves (`runLayer` of `requested`). */
    runLayer: () => runLayer(requested()),
    /** The cell diameter the request gives on frames `frameWidth` px wide. */
    diameter: (frameWidth: number) => diameterPlan(requested(), frameWidth),
    /** Keys of the loaded file that are not params fields. */
    unknown: (): UnknownParam[] => file()?.unknown ?? [],
    /** The config file text of the request (Save config). */
    saveText: (note?: string) =>
      configText(requested(), sources(), {
        ...(note ? { note } : {}),
        ...(file()?.ignored ? { ignored: file()!.ignored } : {}),
      }),
  };
}

/** The sheet's params store. */
export type ParamLayers = ReturnType<typeof createParamLayers>;
