/**
 * An app's params schema (a JSON Schema with the `x-` keywords of the params vocabulary, generated
 * from the app's Rust structs) and partial params layers checked against it.
 *
 * A layer is a partial params object: any subset of the keys, at any depth. Fields are addressed
 * by JSON pointer (`/scales/cell_diameter_px`). The validator is the subset the schema uses: type,
 * `minimum` / `maximum`, `enum` / `const` choices and unknown keys.
 */

/** A schema node: the keywords the params schemas use. */
export interface ParamSchemaNode {
  type?: string | string[];
  $ref?: string;
  anyOf?: ParamSchemaNode[];
  oneOf?: ParamSchemaNode[];
  const?: unknown;
  enum?: unknown[];
  properties?: Record<string, ParamSchemaNode>;
  items?: ParamSchemaNode;
  title?: string;
  description?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  'x-unit'?: string;
  'x-level'?: string;
  'x-when'?: string;
  'x-widget'?: string;
  'x-derived'?: string;
  'x-refined-by'?: string;
  'x-enum-labels'?: string[];
}

/** A whole params schema: the root object, its definitions and its layout version. */
export interface ParamSchema extends ParamSchemaNode {
  properties: Record<string, ParamSchemaNode>;
  $defs?: Record<string, ParamSchemaNode>;
  'x-params-version'?: number;
}

/** Where a field is shown: the pre-run sheet, its Advanced section, or only in files. */
export type ParamLevel = 'main' | 'advanced' | 'internal';

/** One choice of an enum field. */
export interface ParamChoice {
  value: string | number;
  label: string;
  description?: string;
}

/** A settable field of the schema (a leaf: no further fields below it). */
export interface ParamField {
  /** JSON pointer, e.g. `/scales/cell_diameter_px`. */
  pointer: string;
  /** The top-level block it belongs to (`scales`). */
  block: string;
  title: string;
  description: string;
  /** Widget kind, from the type: an enum (string or number choices), a number, a boolean, or other. */
  kind: 'number' | 'integer' | 'enum' | 'boolean' | 'other';
  /** `null` is a valid value (it means what the description says, e.g. "derive"). */
  nullable: boolean;
  default: unknown;
  minimum?: number;
  maximum?: number;
  /** Choices of an enum field, in schema order. */
  choices?: ParamChoice[];
  unit: string;
  level: ParamLevel;
  /** `x-when`: the context the field applies in (`recording`, `joint`, `lookback`, ...). */
  when?: string;
  /** `x-widget`: a named custom widget the app provides. */
  widget?: string;
  /** `x-derived`: the rule that gives the value when it is `null`. */
  derived?: string;
  /** `x-refined-by: data`: the value is a starting value the run may refine. */
  refinedByData: boolean;
}

/** One problem with a layer's value. */
export interface ParamIssue {
  pointer: string;
  message: string;
}

/** A key of a layer that is not a field of the schema. */
export interface UnknownParam {
  pointer: string;
  /** The closest field name at the same place, when one is close. */
  suggestion?: string;
}

/** A layer checked against the schema. */
export interface LayerCheck {
  /** Values of known fields that break the schema (type, range, choices). */
  errors: ParamIssue[];
  /** Keys that are not fields. */
  unknown: UnknownParam[];
  /** The layer without its unknown keys. */
  known: Record<string, unknown>;
}

/** `node` with its `$ref` followed (one level; the generator never chains refs). */
function deref(schema: ParamSchema, node: ParamSchemaNode): ParamSchemaNode {
  if (!node.$ref) return node;
  const name = node.$ref.replace(/^#\/\$defs\//, '');
  const target = schema.$defs?.[name];
  if (!target) throw new Error(`params schema: unknown $ref ${node.$ref}`);
  return { ...target, ...node, $ref: undefined };
}

/** A group of fields (an object with named properties), not a leaf. */
function groupOf(schema: ParamSchema, node: ParamSchemaNode): ParamSchemaNode | null {
  const n = deref(schema, node);
  return n.properties && !n.anyOf ? n : null;
}

function typesOf(n: ParamSchemaNode): string[] {
  return n.type === undefined ? [] : Array.isArray(n.type) ? n.type : [n.type];
}

/** The non-null branch of an `anyOf: [X, null]`, and whether null is allowed. */
function unNull(
  schema: ParamSchema,
  node: ParamSchemaNode,
): { inner: ParamSchemaNode; nullable: boolean } {
  const n = deref(schema, node);
  if (n.anyOf) {
    const rest = n.anyOf.filter((b) => !(b.type === 'null'));
    const nullable = rest.length < n.anyOf.length;
    if (rest.length === 1) return { inner: { ...deref(schema, rest[0]) }, nullable };
  }
  const types = typesOf(n);
  return { inner: n, nullable: types.includes('null') };
}

function choicesOf(n: ParamSchemaNode): ParamChoice[] | undefined {
  if (n.oneOf && n.oneOf.every((b) => b.const !== undefined)) {
    return n.oneOf.map((b) => ({
      value: b.const as string | number,
      label: b.title ?? String(b.const),
      ...(b.description ? { description: b.description } : {}),
    }));
  }
  if (n.enum) {
    const labels = n['x-enum-labels'];
    return n.enum.map((v, i) => ({
      value: v as string | number,
      label: labels?.[i] ?? String(v),
    }));
  }
  return undefined;
}

/** Every settable field of `schema`, depth first in schema order. */
export function schemaFields(schema: ParamSchema): ParamField[] {
  const out: ParamField[] = [];
  const walk = (props: Record<string, ParamSchemaNode>, path: string[]) => {
    for (const [key, raw] of Object.entries(props)) {
      const group = groupOf(schema, raw);
      if (group?.properties) {
        walk(group.properties, [...path, key]);
        continue;
      }
      const { inner, nullable } = unNull(schema, raw);
      const merged: ParamSchemaNode = { ...inner, ...raw, type: inner.type };
      const choices = choicesOf(inner) ?? choicesOf(raw);
      const types = typesOf(inner).filter((t) => t !== 'null');
      const kind: ParamField['kind'] = choices
        ? 'enum'
        : types[0] === 'boolean'
          ? 'boolean'
          : types[0] === 'integer'
            ? 'integer'
            : types[0] === 'number'
              ? 'number'
              : 'other';
      const level = (merged['x-level'] ?? 'internal') as ParamLevel;
      out.push({
        pointer: '/' + [...path, key].join('/'),
        block: path[0] ?? key,
        title: raw.title ?? key,
        description: raw.description ?? '',
        kind,
        nullable,
        default: raw.default,
        ...(merged.minimum !== undefined ? { minimum: merged.minimum } : {}),
        ...(merged.maximum !== undefined ? { maximum: merged.maximum } : {}),
        ...(choices ? { choices } : {}),
        unit: raw['x-unit'] ?? 'none',
        level,
        ...(raw['x-when'] ? { when: raw['x-when'] } : {}),
        ...(raw['x-widget'] ? { widget: raw['x-widget'] } : {}),
        ...(raw['x-derived'] ? { derived: raw['x-derived'] } : {}),
        refinedByData: raw['x-refined-by'] === 'data',
      });
    }
  };
  walk(schema.properties, []);
  return out;
}

/** The title of a top-level block (`Scales`), or its key. */
export function blockTitle(schema: ParamSchema, block: string): string {
  return schema.properties[block]?.title ?? block;
}

/** JSON pointer → path segments (`~1` / `~0` unescaped). */
export function pointerPath(pointer: string): string[] {
  if (pointer === '' || pointer === '/') return [];
  return pointer
    .slice(1)
    .split('/')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The value at `pointer` in `obj` (undefined when a key on the way is missing). */
export function getAt(obj: unknown, pointer: string): unknown {
  let cur: unknown = obj;
  for (const k of pointerPath(pointer)) {
    if (!isObject(cur) || !(k in cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

/** A copy of `obj` with `value` at `pointer` (objects on the way are created). */
export function setAt<T extends Record<string, unknown>>(
  obj: T,
  pointer: string,
  value: unknown,
): T {
  const path = pointerPath(pointer);
  if (path.length === 0) throw new Error('setAt: empty pointer');
  const rec = (o: Record<string, unknown>, i: number): Record<string, unknown> => {
    const k = path[i];
    if (i === path.length - 1) return { ...o, [k]: value };
    const next = isObject(o[k]) ? (o[k] as Record<string, unknown>) : {};
    return { ...o, [k]: rec(next, i + 1) };
  };
  return rec(obj, 0) as T;
}

/** A copy of `obj` without the key at `pointer`; objects left empty are removed too. */
export function deleteAt<T extends Record<string, unknown>>(obj: T, pointer: string): T {
  const path = pointerPath(pointer);
  const rec = (o: Record<string, unknown>, i: number): Record<string, unknown> => {
    const k = path[i];
    if (!(k in o)) return o;
    const { [k]: child, ...rest } = o;
    if (i === path.length - 1) return rest;
    if (!isObject(child)) return o;
    const inner = rec(child, i + 1);
    return Object.keys(inner).length === 0 ? rest : { ...rest, [k]: inner };
  };
  return path.length === 0 ? obj : (rec(obj, 0) as T);
}

/** `layer` over `base`, key by key: objects merge, everything else (arrays, null) replaces. */
export function mergeLayer<T extends Record<string, unknown>>(base: T, layer: unknown): T {
  if (!isObject(layer)) return base;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(layer)) {
    const b = out[k];
    out[k] = isObject(v) && isObject(b) ? mergeLayer(b, v) : v;
  }
  return out as T;
}

/**
 * Every pointer `layer` sets, mapped to its value. Descends only through schema groups, so a
 * leaf whose value is an object (a crop rectangle) is one entry.
 */
export function layerEntries(schema: ParamSchema, layer: unknown): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const walk = (node: ParamSchemaNode | null, v: unknown, ptr: string) => {
    const group = node ? groupOf(schema, node) : null;
    if (ptr !== '' && !(group && isObject(v))) {
      out.set(ptr, v);
      return;
    }
    if (!isObject(v)) return;
    const props = ptr === '' ? schema.properties : (group?.properties ?? {});
    for (const [k, x] of Object.entries(v)) walk(props[k] ?? null, x, `${ptr}/${k}`);
  };
  walk(null, layer, '');
  return out;
}

/** Edit distance, for "did you mean" on unknown keys. */
function distance(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return d[b.length];
}

function suggest(key: string, names: string[]): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  for (const n of names) {
    const dd = distance(key, n);
    if (dd < bestD) {
      bestD = dd;
      best = n;
    }
  }
  return best !== undefined && bestD <= Math.max(2, Math.floor(key.length / 3)) ? best : undefined;
}

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

/** Problems of `v` as a value of the leaf `node` (empty: valid). */
function checkValue(
  schema: ParamSchema,
  node: ParamSchemaNode,
  v: unknown,
  ptr: string,
  out: ParamIssue[],
): void {
  const { inner, nullable } = unNull(schema, node);
  if (v === null) {
    if (!nullable) out.push({ pointer: ptr, message: 'may not be null' });
    return;
  }
  const choices = choicesOf(inner) ?? choicesOf(node);
  if (choices) {
    if (!choices.some((c) => c.value === v)) {
      out.push({
        pointer: ptr,
        message: `must be one of ${choices.map((c) => JSON.stringify(c.value)).join(', ')}`,
      });
    }
    return;
  }
  const types = typesOf(inner).filter((t) => t !== 'null');
  const t = typeName(v);
  const okType =
    types.length === 0 || types.some((ty) => ty === t || (ty === 'number' && t === 'integer'));
  if (!okType) {
    out.push({ pointer: ptr, message: `must be ${types.join(' or ')}, got ${t}` });
    return;
  }
  if (typeof v === 'number') {
    const min = inner.minimum ?? node.minimum;
    const max = inner.maximum ?? node.maximum;
    if (!Number.isFinite(v)) out.push({ pointer: ptr, message: 'must be a finite number' });
    else if (min !== undefined && v < min)
      out.push({ pointer: ptr, message: `must be at least ${min}` });
    else if (max !== undefined && v > max)
      out.push({ pointer: ptr, message: `must be at most ${max}` });
  }
  if (Array.isArray(v) && inner.items) {
    v.forEach((x, i) => checkValue(schema, inner.items!, x, `${ptr}/${i}`, out));
  }
  if (isObject(v) && inner.properties) {
    for (const [k, x] of Object.entries(v)) {
      const p = inner.properties[k];
      if (!p) out.push({ pointer: `${ptr}/${k}`, message: 'is not a field' });
      else checkValue(schema, p, x, `${ptr}/${k}`, out);
    }
  }
}

/** Check a partial layer: errors for bad values, unknown keys listed (and dropped from `known`). */
export function checkLayer(schema: ParamSchema, layer: unknown): LayerCheck {
  const errors: ParamIssue[] = [];
  const unknown: UnknownParam[] = [];
  const walk = (props: Record<string, ParamSchemaNode>, v: unknown, ptr: string): unknown => {
    if (!isObject(v)) {
      errors.push({ pointer: ptr || '/', message: 'must be an object' });
      return {};
    }
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const p = props[k];
      const here = `${ptr}/${k}`;
      if (!p) {
        const s = suggest(k, Object.keys(props));
        unknown.push({ pointer: here, ...(s ? { suggestion: s } : {}) });
        continue;
      }
      const group = groupOf(schema, p);
      if (group?.properties) {
        out[k] = walk(group.properties, x, here);
      } else {
        checkValue(schema, p, x, here, errors);
        out[k] = x;
      }
    }
    return out;
  };
  const known = walk(schema.properties, layer, '') as Record<string, unknown>;
  return { errors, unknown, known };
}

/** Problems of one field's value (empty: valid). */
export function checkField(schema: ParamSchema, pointer: string, value: unknown): ParamIssue[] {
  return checkLayer(schema, setAt({}, pointer, value)).errors;
}

/**
 * `text` without `//` line comments and `/* *\/` block comments. Text inside JSON strings is
 * kept, so a URL in a string survives.
 */
export function stripJsonComments(text: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\' && i + 1 < text.length) {
        out += text[i + 1];
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Parse JSON that may carry `//` and `/* *\/` comments. Throws `SyntaxError` like `JSON.parse`. */
export function parseJsonWithComments(text: string): unknown {
  return JSON.parse(stripJsonComments(text));
}
