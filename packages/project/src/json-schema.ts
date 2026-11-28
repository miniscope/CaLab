/**
 * A validator for the subset of JSON Schema the envelope schemas use: `$ref` to `#/$defs/*`,
 * `type` (one or a list), `const`, `enum`, `anyOf`, `properties` / `required`,
 * `additionalProperties` given as a schema (a map), `items`, `minItems` / `maxItems` and
 * `minimum`. Keys a schema does not list are allowed: a file from a newer minor build keeps
 * them. Anything outside the subset throws, so a schema cannot silently stop being checked.
 */

/** A JSON Schema node (the subset above). */
export interface SchemaNode {
  $ref?: string;
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  anyOf?: SchemaNode[];
  properties?: Record<string, SchemaNode>;
  required?: string[];
  additionalProperties?: boolean | SchemaNode;
  items?: SchemaNode;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  $defs?: Record<string, SchemaNode>;
  [key: string]: unknown;
}

/** One place a document breaks its schema. */
export interface SchemaError {
  /** JSON pointer into the document ('' for the root). */
  pointer: string;
  message: string;
}

const KNOWN = new Set([
  '$schema',
  '$id',
  '$ref',
  '$defs',
  'title',
  'description',
  'type',
  'const',
  'enum',
  'anyOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  'minimum',
]);

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function hasType(v: unknown, t: string): boolean {
  const n = typeName(v);
  return n === t || (t === 'number' && n === 'integer');
}

const esc = (k: string) => k.replace(/~/g, '~0').replace(/\//g, '~1');

/** Every place `value` breaks `schema` (empty: valid). `root` holds the `$defs`. */
export function validate(
  schema: SchemaNode,
  value: unknown,
  root: SchemaNode = schema,
  pointer = '',
): SchemaError[] {
  for (const k of Object.keys(schema))
    if (!KNOWN.has(k) && !k.startsWith('x-'))
      throw new Error(`schema keyword "${k}" is not supported (at ${pointer || '/'})`);
  if (schema.$ref) {
    const name = schema.$ref.startsWith('#/$defs/') ? schema.$ref.slice(8) : null;
    const target = name ? root.$defs?.[name] : undefined;
    if (!target) throw new Error(`unresolved $ref ${schema.$ref}`);
    return validate(target, value, root, pointer);
  }
  const fail = (message: string): SchemaError[] => [{ pointer, message }];
  if (schema.anyOf) {
    const branches = schema.anyOf.map((s) => validate(s, value, root, pointer));
    if (branches.some((b) => b.length === 0)) return [];
    // Report the branch that got furthest (fewest errors), so a nullable object's own errors show.
    return branches.reduce((a, b) => (b.length < a.length ? b : a));
  }
  if ('const' in schema && value !== schema.const)
    return fail(`must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value as never))
    return fail(`must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`);
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => hasType(value, t)))
      return fail(`must be ${types.join(' or ')}, not ${typeName(value)}`);
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum)
    return fail(`must be at least ${schema.minimum}`);
  const out: SchemaError[] = [];
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      out.push({ pointer, message: `must have at least ${schema.minItems} items` });
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      out.push({ pointer, message: `must have at most ${schema.maxItems} items` });
    if (schema.items)
      value.forEach((v, i) => out.push(...validate(schema.items!, v, root, `${pointer}/${i}`)));
  } else if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    for (const k of schema.required ?? [])
      if (!(k in obj)) out.push({ pointer: `${pointer}/${esc(k)}`, message: 'is missing' });
    for (const [k, v] of Object.entries(obj)) {
      const p = `${pointer}/${esc(k)}`;
      const prop = schema.properties?.[k];
      if (prop) out.push(...validate(prop, v, root, p));
      else if (typeof schema.additionalProperties === 'object')
        out.push(...validate(schema.additionalProperties, v, root, p));
    }
  }
  return out;
}

/** The errors as one line each, for a message (at most `max`, then a count of the rest). */
export function describeErrors(errors: readonly SchemaError[], max = 5): string {
  const lines = errors.slice(0, max).map((e) => `${e.pointer || '/'} ${e.message}`);
  if (errors.length > max) lines.push(`and ${errors.length - max} more`);
  return lines.join('; ');
}
