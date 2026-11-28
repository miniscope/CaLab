/**
 * How an app plugs its params into the project files. The shared layer never looks inside a
 * params block: an app registers its JSON Schema (with the `x-` field metadata) and a migration
 * hook, and the project files store that app's partial params by app id.
 */
import type { ProjectFile } from './generated/files';
import type { ParamSchema } from '@calab/core';

/** What an app registers. */
export interface AppParams {
  /** `cala`, `cadecon`, ... */
  app: string;
  /** The params layout version this build of the app reads and writes. */
  paramsVersion: number;
  /** The `config.schema` name written into run files, e.g. `cala-params`. */
  schemaName: string;
  schema: ParamSchema;
  /** `params` of layout version `from` migrated to `paramsVersion` (cala: through wasm). */
  migrate(params: unknown, from: number): unknown;
}

const registry = new Map<string, AppParams>();

/** Register (or replace) an app's params. */
export function registerApp(a: AppParams): void {
  registry.set(a.app, a);
}

/** The registered params of `app`; throws when the app never registered. */
export function appParams(app: string): AppParams {
  const a = registry.get(app);
  if (!a) throw new Error(`No params are registered for app "${app}".`);
  return a;
}

/**
 * A project's default params for `app`, migrated to the app's layout version (empty when the
 * project sets none). A layout newer than the app's throws: it cannot be read safely.
 */
export function projectDefaults(project: ProjectFile, app: string): Record<string, unknown> {
  const d = project.defaults[app];
  if (!d) return {};
  const a = appParams(app);
  if (d.params_version > a.paramsVersion)
    throw new Error(
      `The project's ${app} defaults are params version ${d.params_version}, newer than this app's ${a.paramsVersion}.`,
    );
  return (
    d.params_version < a.paramsVersion ? a.migrate(d.params, d.params_version) : d.params
  ) as Record<string, unknown>;
}
