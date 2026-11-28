// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest';
import { defaultParams } from '../../lib/cala-wasm.ts';
import { initTestWasm } from '../../__tests__/wasm-test.ts';
import { schemaDefaults } from '../schema.ts';

beforeAll(initTestWasm);

describe('cala params in the wasm', () => {
  it('the wasm defaults are the schema defaults (same commit)', () => {
    expect(JSON.parse(defaultParams())).toEqual(schemaDefaults());
  });
});
