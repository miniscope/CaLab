/**
 * cala's config files (`calab-config`, `apps/cala/docs/config-files.md`): the params a user asked
 * for, without session ids, so one file moves between recordings and animals.
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
  setAt,
  type ParamIssue,
  type ParamSchema,
  type UnknownParam,
} from '@calab/core';
import { CALA_PARAMS_SCHEMA, CALA_PARAMS_VERSION } from '../params/schema.ts';
import type { ParamsLayer } from './run-params.ts';

/** The `format` string of a config file. */
export const CONFIG_FORMAT = 'calab-config';
/** The envelope version of the config files this build writes and reads. */
export const CONFIG_VERSION = 1;

/** The params schema as the shared helpers type it. */
export const PARAMS_SCHEMA = CALA_PARAMS_SCHEMA as unknown as ParamSchema;

/** A source tag of a requested value: set in the sheet, or from a loaded file. */
export type RequestSource = 'ui' | `file:${string}`;

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
      return { params: config.requested ?? {}, kind: 'run', version: file.params_version };
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
export function readConfig(text: string, name: string): LoadedConfig | ConfigRefusal {
  let json: unknown;
  try {
    json = parseJsonWithComments(text);
  } catch (e) {
    return refuse(`Not JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isObject(json)) return refuse('Not a JSON object.');
  const got = paramsOf(json);
  if ('message' in got) return got;
  if (got.version !== undefined && got.version !== CALA_PARAMS_VERSION) {
    return refuse(
      `Params version ${String(got.version)}; this cala reads version ${CALA_PARAMS_VERSION}.`,
    );
  }
  if (!isObject(got.params)) return refuse('Its params are not an object.');
  const check = checkLayer(PARAMS_SCHEMA, got.params);
  if (check.errors.length > 0) {
    return refuse('Some values are outside what the settings allow.', check.errors);
  }
  if (got.kind === 'params' && Object.keys(check.known).length === 0) {
    return refuse('No cala settings in this file.');
  }
  let ignored: Record<string, unknown> = {};
  for (const u of check.unknown) ignored = setAt(ignored, u.pointer, getAt(got.params, u.pointer));
  return {
    name,
    layer: check.known as ParamsLayer,
    unknown: check.unknown,
    ignored,
    ...(typeof json.note === 'string' ? { note: json.note } : {}),
    kind: got.kind,
  };
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
