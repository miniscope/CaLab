/**
 * cala's config files (`calab-config`; USER_GUIDE.md "Config files", example in
 * `apps/cala/docs/example-config.json`): the params a user asked for, without session ids, so one
 * file moves between recordings and animals.
 *
 * A file is JSON; `//` and block comments are accepted on read and never written. Its `params`
 * is a partial params object: missing keys take their defaults. Load checks it against the schema:
 * a value out of its range or of the wrong type refuses the file; a key that is not a params field
 * is listed as a warning and kept (Save writes it back), but never reaches the run.
 */
import {
  checkLayer,
  getAt,
  layerEntries,
  parseJsonWithComments,
  schemaFields,
  setAt,
  type ParamIssue,
  type ParamSchema,
  type UnknownParam,
} from '@calab/core';
import { CALA_PARAMS_SCHEMA, CALA_PARAMS_VERSION } from '../params/schema.ts';
import type { ParamsLayer } from './run-params.ts';
import { exportRunFile } from './result-file.ts';
import { errMsg } from './errors.ts';

/** The `format` string of a config file. */
export const CONFIG_FORMAT = 'calab-config';
/** The envelope version of the config files this build writes and reads. */
export const CONFIG_VERSION = 1;

/** The params schema as the shared helpers type it. */
export const PARAMS_SCHEMA = CALA_PARAMS_SCHEMA as unknown as ParamSchema;

/**
 * A source tag of a requested value (`docs/projects.md`, "Settings layers"): the project's defaults, the plan step, the
 * stream's overrides, a loaded file, or set in the sheet.
 */
export type RequestSource = 'project' | 'step' | 'stream' | 'ui' | `file:${string}`;

/** A config file as read. */
export interface LoadedConfig {
  /** The file's name (the `file:<name>` source tag). */
  name: string;
  /** Its params that are params fields: a valid partial layer. */
  layer: ParamsLayer;
  /** Keys that are not params fields, with a suggestion when one is close. */
  unknown: UnknownParam[];
  /** The values of those keys, as given (kept so Save writes them back). */
  ignored: Record<string, unknown>;
  /** The file's `note`, if any. */
  note?: string;
  /** What the file was: a config, a run file's request, or a bare params object. */
  kind: 'config' | 'run' | 'params';
  /**
   * A run file (or an export's): the values the data set (`derived`) that can be pinned as
   * settings, pointer → value. Absent: none.
   */
  derived?: Record<string, unknown>;
  /** The derived values pinned into `layer` (Load with "also pin what the data set"). */
  pinned?: string[];
}

/** How a run file's `derived` pointer is pinned as a setting (others: the same pointer). */
const DERIVED_SETTING: Record<string, string> = { '/time/fps': '/time/fps_override' };

/**
 * The settings a run file's `derived` values can be pinned as: pointer of the setting → value.
 * A derived value whose pointer is not a setting, or that is not a plain value, is left out.
 */
export function derivedSettings(run: Record<string, unknown>): Record<string, unknown> {
  const derived = isObject(run.derived) ? run.derived : {};
  const fields = new Set(schemaFields(PARAMS_SCHEMA).map((f) => f.pointer));
  const out: Record<string, unknown> = {};
  for (const [ptr, d] of Object.entries(derived)) {
    const value = isObject(d) ? d.value : undefined;
    const target = DERIVED_SETTING[ptr] ?? ptr;
    if (fields.has(target) && (typeof value === 'number' || typeof value === 'boolean'))
      out[target] = value;
  }
  return out;
}

/** Why a file could not be loaded. */
export interface ConfigRefusal {
  message: string;
  /** Values that break the schema, by pointer. */
  errors: ParamIssue[];
}

/** The written form of a config file. */
export interface ConfigFile {
  format: typeof CONFIG_FORMAT;
  version: number;
  app: 'cala';
  params_version: number;
  note?: string;
  /** Every requested value (and any kept unknown key). */
  params: Record<string, unknown>;
  /** JSON pointer → where the value came from when it was saved (`ui`, `file:<name>`). */
  sources: Record<string, RequestSource>;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const refuse = (message: string, errors: ParamIssue[] = []): ConfigRefusal => ({
  message,
  errors,
});

/** The params object a dropped file carries, by its `format`. */
function paramsOf(
  file: Record<string, unknown>,
): { params: unknown; kind: LoadedConfig['kind']; version: unknown } | ConfigRefusal {
  switch (file.format) {
    case CONFIG_FORMAT:
      if (file.app !== undefined && file.app !== 'cala')
        return refuse(`This config is for ${String(file.app)}, not cala.`);
      if (typeof file.version === 'number' && file.version > CONFIG_VERSION)
        return refuse(`Config version ${file.version} is newer than this cala reads.`);
      return { params: file.params ?? {}, kind: 'config', version: file.params_version };
    case 'calab-run': {
      const config = isObject(file.config) ? file.config : {};
      return { params: config.requested ?? {}, kind: 'run', version: config.params_version };
    }
    case undefined: {
      // A config written by hand without its envelope keys.
      if (isObject(file.params))
        return { params: file.params, kind: 'config', version: file.params_version };
      // A bare partial params object (a `qc_eval --params` file): its keys are params blocks.
      const { params_version: version, ...rest } = file;
      return { params: rest, kind: 'params', version };
    }
    default:
      return refuse(`"${String(file.format)}" is not a config file cala reads.`);
  }
}

/** Read a config file's text. */
export function readConfig(
  text: string,
  name: string,
  opts: { pinDerived?: boolean } = {},
): LoadedConfig | ConfigRefusal {
  let json: unknown;
  try {
    json = parseJsonWithComments(text);
  } catch (e) {
    return refuse(`Not JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  return readConfigJson(json, name, opts);
}

/**
 * Read a parsed config: a `calab-config`, a run file (its `config.requested`; with `pinDerived`
 * also the values the data set, as settings), or a bare params object.
 */
export function readConfigJson(
  json: unknown,
  name: string,
  opts: { pinDerived?: boolean } = {},
): LoadedConfig | ConfigRefusal {
  if (!isObject(json)) return refuse('Not a JSON object.');
  const got = paramsOf(json);
  if ('message' in got) return got;
  if (got.version !== undefined && got.version !== CALA_PARAMS_VERSION) {
    return refuse(
      `Params version ${String(got.version)}; this cala reads version ${CALA_PARAMS_VERSION}.`,
    );
  }
  if (!isObject(got.params)) return refuse('Its params are not an object.');
  const derived = got.kind === 'run' ? derivedSettings(json) : {};
  const pinned = opts.pinDerived ? Object.keys(derived) : [];
  let params: Record<string, unknown> = got.params;
  for (const ptr of pinned) params = setAt(params, ptr, derived[ptr]);
  const check = checkLayer(PARAMS_SCHEMA, params);
  if (check.errors.length > 0) {
    return refuse('Some values are outside what the settings allow.', check.errors);
  }
  if (got.kind === 'params' && Object.keys(check.known).length === 0) {
    return refuse('No cala settings in this file.');
  }
  let ignored: Record<string, unknown> = {};
  for (const u of check.unknown) ignored = setAt(ignored, u.pointer, getAt(params, u.pointer));
  return {
    name,
    layer: check.known as ParamsLayer,
    unknown: check.unknown,
    ignored,
    ...(typeof json.note === 'string' ? { note: json.note } : {}),
    kind: got.kind,
    ...(Object.keys(derived).length > 0 ? { derived } : {}),
    ...(pinned.length > 0 ? { pinned } : {}),
  };
}

/**
 * Read a config from a dropped file: JSON (a config, a run file or params), or a cala export
 * (`.npz`), whose `meta_json.run` is the run file it was written with.
 */
export async function readConfigFile(
  file: File,
  opts: { pinDerived?: boolean } = {},
): Promise<LoadedConfig | ConfigRefusal> {
  if (!file.name.toLowerCase().endsWith('.npz'))
    return readConfig(await file.text(), file.name, opts);
  let run: Record<string, unknown> | null;
  try {
    run = await exportRunFile(file);
  } catch (e) {
    return refuse(errMsg(e));
  }
  if (!run)
    return refuse(
      'This export is older than the run file (format 8): it does not carry its settings.',
    );
  return readConfigJson(run, file.name, opts);
}

/** True when `readConfig` refused the file. */
export function isRefusal(r: LoadedConfig | ConfigRefusal): r is ConfigRefusal {
  return 'message' in r;
}

/** The text of a config file holding `params`, each value tagged with its source. */
export function configText(
  params: ParamsLayer,
  sources: Record<string, RequestSource>,
  opts: { note?: string; ignored?: Record<string, unknown> } = {},
): string {
  const kept: Record<string, RequestSource> = {};
  for (const ptr of layerEntries(PARAMS_SCHEMA, params).keys()) {
    if (sources[ptr]) kept[ptr] = sources[ptr];
  }
  const file: ConfigFile = {
    format: CONFIG_FORMAT,
    version: CONFIG_VERSION,
    app: 'cala',
    params_version: CALA_PARAMS_VERSION,
    ...(opts.note ? { note: opts.note } : {}),
    params: mergeIgnored(params as Record<string, unknown>, opts.ignored ?? {}),
    sources: kept,
  };
  return JSON.stringify(file, null, 2) + '\n';
}

function mergeIgnored(
  params: Record<string, unknown>,
  ignored: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...params };
  for (const [k, v] of Object.entries(ignored)) {
    out[k] = isObject(v) && isObject(out[k]) ? mergeIgnored(out[k], v) : v;
  }
  return out;
}

/**
 * The config file of a run (its run file's `config.requested`, tagged with the run's sources):
 * what the run asked for, without what the data set. Null when the run file has no usable
 * request.
 */
export function runConfigText(run: object, note?: string): string | null {
  const r = readConfigJson(run, 'run');
  if (isRefusal(r)) return null;
  const config = (run as { config?: { sources?: unknown } }).config;
  const sources = isObject(config?.sources)
    ? (config.sources as Record<string, RequestSource>)
    : {};
  return configText(r.layer, sources, {
    ...(note ? { note } : {}),
    ...(Object.keys(r.ignored).length > 0 ? { ignored: r.ignored } : {}),
  });
}
