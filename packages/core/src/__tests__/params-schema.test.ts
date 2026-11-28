import { describe, it, expect } from 'vitest';
import {
  checkField,
  checkLayer,
  deleteAt,
  getAt,
  layerEntries,
  mergeLayer,
  parseJsonWithComments,
  schemaFields,
  setAt,
  type ParamSchema,
} from '../params-schema.ts';

/** The shapes the generated params schemas use: refs, nullable types, oneOf and numeric enums. */
const SCHEMA: ParamSchema = {
  type: 'object',
  'x-params-version': 1,
  properties: {
    scales: { $ref: '#/$defs/Scales', title: 'Scales', default: {} },
    settle: { $ref: '#/$defs/Settle', title: 'Settle', default: {} },
    input: { $ref: '#/$defs/Input', title: 'Input', default: {} },
  },
  $defs: {
    Scales: {
      type: 'object',
      properties: {
        cell_diameter_px: {
          type: ['number', 'null'],
          title: 'Diameter',
          description: 'd',
          minimum: 4,
          maximum: 64,
          default: 10,
          'x-unit': 'px',
          'x-level': 'advanced',
          'x-refined-by': 'data',
        },
        count: { type: 'integer', title: 'Count', minimum: 0, default: 1, 'x-level': 'internal' },
        on: { type: 'boolean', title: 'On', default: true, 'x-level': 'main' },
      },
    },
    Settle: {
      type: 'object',
      properties: {
        level: { $ref: '#/$defs/Level', title: 'Level', default: 'a', 'x-level': 'main' },
        cap: {
          type: 'number',
          title: 'Cap',
          enum: [0, 0.5, 2],
          'x-enum-labels': ['Off', 'Half', 'Two'],
          default: 2,
          'x-level': 'main',
        },
      },
    },
    Level: {
      oneOf: [
        { type: 'string', const: 'a', title: 'A' },
        { type: 'string', const: 'b', title: 'B' },
      ],
    },
    Input: {
      type: 'object',
      properties: {
        crop: {
          anyOf: [{ $ref: '#/$defs/Rect' }, { type: 'null' }],
          title: 'Crop',
          default: null,
          'x-level': 'main',
          'x-widget': 'crop-rect',
        },
      },
    },
    Rect: {
      type: 'object',
      properties: { x: { type: 'integer', minimum: 0 }, w: { type: 'integer', minimum: 1 } },
    },
  },
};

describe('schemaFields', () => {
  it('lists every leaf with its kind, range, level and choices', () => {
    const f = schemaFields(SCHEMA);
    expect(f.map((x) => x.pointer)).toEqual([
      '/scales/cell_diameter_px',
      '/scales/count',
      '/scales/on',
      '/settle/level',
      '/settle/cap',
      '/input/crop',
    ]);
    const d = f[0];
    expect(d).toMatchObject({
      kind: 'number',
      nullable: true,
      minimum: 4,
      maximum: 64,
      unit: 'px',
      level: 'advanced',
      refinedByData: true,
      block: 'scales',
    });
    expect(f[1]).toMatchObject({ kind: 'integer', nullable: false, level: 'internal' });
    expect(f[2].kind).toBe('boolean');
    expect(f[3].choices).toEqual([
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' },
    ]);
    expect(f[4].choices?.map((c) => c.label)).toEqual(['Off', 'Half', 'Two']);
    expect(f[5]).toMatchObject({ kind: 'other', nullable: true, widget: 'crop-rect' });
  });
});

describe('checkLayer', () => {
  it('accepts a valid partial layer', () => {
    const c = checkLayer(SCHEMA, { scales: { cell_diameter_px: 16 } });
    expect(c.errors).toEqual([]);
    expect(c.unknown).toEqual([]);
    expect(c.known).toEqual({ scales: { cell_diameter_px: 16 } });
  });

  it('reports range, type, null and choice errors by pointer', () => {
    const c = checkLayer(SCHEMA, {
      scales: { cell_diameter_px: 2, count: 1.5, on: null },
      settle: { level: 'c', cap: 1 },
      input: { crop: { x: -1, w: 4 } },
    });
    expect(c.errors.map((e) => e.pointer)).toEqual([
      '/scales/cell_diameter_px',
      '/scales/count',
      '/scales/on',
      '/settle/level',
      '/settle/cap',
      '/input/crop/x',
    ]);
    expect(c.errors[0].message).toBe('must be at least 4');
  });

  it('lists unknown keys with a suggestion and drops them from the known layer', () => {
    const c = checkLayer(SCHEMA, { scales: { cell_diameter: 12, on: false }, bogus: 1 });
    expect(c.unknown).toEqual([
      { pointer: '/scales/cell_diameter', suggestion: 'cell_diameter_px' },
      { pointer: '/bogus' },
    ]);
    expect(c.known).toEqual({ scales: { on: false } });
  });

  it('checks one field', () => {
    expect(checkField(SCHEMA, '/scales/cell_diameter_px', null)).toEqual([]);
    expect(checkField(SCHEMA, '/scales/cell_diameter_px', 65)).toHaveLength(1);
  });
});

describe('layer helpers', () => {
  it('set, get, delete and merge by pointer', () => {
    const a = setAt({}, '/scales/cell_diameter_px', 12);
    expect(getAt(a, '/scales/cell_diameter_px')).toBe(12);
    expect(getAt(a, '/scales/on')).toBeUndefined();
    expect(deleteAt(a, '/scales/cell_diameter_px')).toEqual({});
    expect(mergeLayer({ scales: { on: true, count: 1 } }, { scales: { count: 2 } })).toEqual({
      scales: { on: true, count: 2 },
    });
  });

  it('lists the pointers a layer sets, keeping object-valued leaves whole', () => {
    const m = layerEntries(SCHEMA, {
      scales: { cell_diameter_px: null },
      input: { crop: { x: 1, w: 2 } },
    });
    expect([...m.entries()]).toEqual([
      ['/scales/cell_diameter_px', null],
      ['/input/crop', { x: 1, w: 2 }],
    ]);
  });
});

describe('parseJsonWithComments', () => {
  it('drops line and block comments but keeps // inside strings', () => {
    const v = parseJsonWithComments(`{
      // a comment
      "note": "see https://example.org/x", /* block */
      "n": 1 // trailing
    }`);
    expect(v).toEqual({ note: 'see https://example.org/x', n: 1 });
  });

  it('keeps escaped quotes inside strings', () => {
    expect(parseJsonWithComments('{"a": "x\\" // y"}')).toEqual({ a: 'x" // y' });
  });
});
