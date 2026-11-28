/**
 * The cala params schema, generated from the Rust structs in
 * `crates/cala/src/params` (`npm run gen:params`). This module is the one
 * TS import of the schema file; `cala-params.d.ts` holds its types.
 */
import schemaJson from '../../../../crates/cala/schema/cala-params.schema.json';
import type { CalaParams } from './cala-params.d.ts';

/** A JSON Schema with the `x-` keywords of the params vocabulary. */
export type ParamsSchema = typeof schemaJson;

/** The params schema, with every field's default and metadata. */
export const CALA_PARAMS_SCHEMA: ParamsSchema = schemaJson;

/** The params layout version of this build. */
export const CALA_PARAMS_VERSION: number = schemaJson['x-params-version'];

/** The defaults the schema states, as one params object. */
export function schemaDefaults(): CalaParams {
  const out: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(CALA_PARAMS_SCHEMA.properties)) {
    out[k] = (p as { default: unknown }).default;
  }
  return out as unknown as CalaParams;
}
