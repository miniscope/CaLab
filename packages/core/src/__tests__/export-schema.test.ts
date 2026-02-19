import { describe, it, expect } from 'vitest';
import * as v from 'valibot';
import { CaTuneExportSchema } from '../schemas/export-schema.ts';

function makeValidExport() {
  return {
    schema_version: '1.0',
    catune_version: '2.0.0',
    export_date: '2024-01-01T00:00:00Z',
    parameters: {
      tau_rise_s: 0.01,
      tau_decay_s: 1.0,
      lambda: 0.1,
      sampling_rate_hz: 30,
      filter_enabled: false,
    },
    ar2_coefficients: {
      decayRoot: 0.967,
      riseRoot: 0.717,
      g1: 1.684,
      g2: -0.693,
      dt: 0.0333,
    },
    formulation: {
      model: 'AR(2)',
      objective: 'min ||y - Cx||² + λ||x||₁',
      kernel: 'calcium impulse response',
      ar2_relation: 'g1*c[t-1] + g2*c[t-2]',
      lambda_definition: 'sparsity penalty',
      convergence: 'FISTA',
    },
    metadata: {},
  };
}

describe('CaTuneExportSchema', () => {
  it('validates a complete valid object', () => {
    const result = v.safeParse(CaTuneExportSchema, makeValidExport());
    expect(result.success).toBe(true);
  });

  it('validates when optional metadata fields are omitted', () => {
    const data = makeValidExport();
    // metadata has all optional fields, so empty object should work
    data.metadata = {};
    const result = v.safeParse(CaTuneExportSchema, data);
    expect(result.success).toBe(true);
  });

  it('fails when required field (parameters) is missing', () => {
    const data = makeValidExport();
    const { parameters: _, ...incomplete } = data;
    const result = v.safeParse(CaTuneExportSchema, incomplete);
    expect(result.success).toBe(false);
  });

  it('fails when a number field has wrong type', () => {
    const data = makeValidExport();
    (data.parameters as Record<string, unknown>).tau_rise_s = 'not-a-number';
    const result = v.safeParse(CaTuneExportSchema, data);
    expect(result.success).toBe(false);
  });

  it('fails when a nested required field is missing', () => {
    const data = makeValidExport();
    const { g1: _, ...incompleteAR2 } = data.ar2_coefficients;
    (data as Record<string, unknown>).ar2_coefficients = incompleteAR2;
    const result = v.safeParse(CaTuneExportSchema, data);
    expect(result.success).toBe(false);
  });

  it('accepts extra fields (valibot strips by default)', () => {
    const data = makeValidExport();
    (data as Record<string, unknown>).extra_field = 'should be ignored';
    const result = v.safeParse(CaTuneExportSchema, data);
    expect(result.success).toBe(true);
  });
});
