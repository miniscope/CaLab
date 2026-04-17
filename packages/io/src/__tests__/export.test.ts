import { describe, it, expect } from 'vitest';
import { tauToShape } from '@calab/compute';
import { buildExportData, parseExport } from '../export.ts';

// Derive a (tPeak, fwhm) pair from realistic tau values so buildExportData
// (which goes through shapeToTau) doesn't bail on degenerate shapes.
const { tPeak, fwhm } = tauToShape(0.02, 0.4)!;

describe('buildExportData → parseExport roundtrip', () => {
  it('preserves all fields through JSON stringify / parse', () => {
    const original = buildExportData(
      tPeak,
      fwhm,
      0.01,
      30,
      true,
      { sourceFilename: 'traces.npy', numCells: 42, numTimepoints: 9000 },
      '1.0.0-test',
    );

    const rehydrated = parseExport(JSON.parse(JSON.stringify(original)));

    expect(rehydrated).toEqual(original);
  });

  it('preserves all fields without optional metadata', () => {
    const original = buildExportData(tPeak, fwhm, 0.01, 30, false);
    const rehydrated = parseExport(JSON.parse(JSON.stringify(original)));
    expect(rehydrated).toEqual(original);
  });

  it('throws on malformed input missing required fields', () => {
    expect(() => parseExport({ schema_version: '1.2.0' })).toThrow(/Invalid CaTune export/);
  });

  it('throws on wrong types', () => {
    const valid = buildExportData(tPeak, fwhm, 0.01, 30, true);
    const corrupted = JSON.parse(JSON.stringify(valid));
    corrupted.parameters.lambda = 'not-a-number';
    expect(() => parseExport(corrupted)).toThrow(/Invalid CaTune export/);
  });

  it('accepts a legacy export missing optional t_peak_s/fwhm_s', () => {
    const valid = buildExportData(tPeak, fwhm, 0.01, 30, true);
    const legacy = JSON.parse(JSON.stringify(valid));
    delete legacy.parameters.t_peak_s;
    delete legacy.parameters.fwhm_s;
    const parsed = parseExport(legacy);
    expect(parsed.parameters.tau_rise_s).toBe(valid.parameters.tau_rise_s);
    expect(parsed.parameters.tau_decay_s).toBe(valid.parameters.tau_decay_s);
  });
});
