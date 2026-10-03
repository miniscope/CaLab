import { describe, it, expect } from 'vitest';
import type { DataSource } from '@calab/core';
import {
  buildBaseSubmissionPayload,
  hashSubmissionDataset,
  parseOptionalNumber,
  toCommunityDataSource,
  type BaseSubmissionContext,
  type FormFields,
} from '../submission-payload.ts';

const FIELDS: FormFields = {
  indicator: ' GCaMP6f ',
  species: 'mouse',
  brainRegion: 'cortex',
  labName: '  ',
  orcid: '0000-0001-2345-6789',
  virusConstruct: 'AAV1',
  timeSinceInjection: '21',
  notes: '',
  microscopeType: '2-photon',
  cellType: '',
  imagingDepth: '150.5',
};

function ctx(overrides: Partial<BaseSubmissionContext> = {}): BaseSubmissionContext {
  return {
    dataSource: 'file',
    demoIndicator: undefined,
    samplingRate: 30,
    numCells: 12,
    recordingLengthS: 600,
    datasetHash: 'abc',
    appVersion: '1.2.3',
    ...overrides,
  };
}

describe('toCommunityDataSource', () => {
  // The community tables store 'user' | 'demo' | 'bridge' | 'training'; the
  // apps track 'file' | 'demo' | 'bridge' | null. Every app value must map.
  it.each<[DataSource | null, string]>([
    ['file', 'user'],
    ['demo', 'demo'],
    ['bridge', 'bridge'],
    [null, 'user'],
  ])('maps %s to %s', (source, expected) => {
    expect(toCommunityDataSource(source)).toBe(expected);
  });
});

describe('parseOptionalNumber', () => {
  it('returns undefined for empty or non-numeric input', () => {
    expect(parseOptionalNumber('')).toBeUndefined();
    expect(parseOptionalNumber('abc')).toBeUndefined();
  });

  it('uses the given parser', () => {
    expect(parseOptionalNumber('21.9', (s) => parseInt(s, 10))).toBe(21);
    expect(parseOptionalNumber('21.9')).toBe(21.9);
  });
});

describe('buildBaseSubmissionPayload', () => {
  it('trims form fields and maps the file source to user', () => {
    const p = buildBaseSubmissionPayload(FIELDS, ctx());
    expect(p.indicator).toBe('GCaMP6f');
    expect(p.lab_name).toBeUndefined();
    expect(p.notes).toBeUndefined();
    expect(p.cell_type).toBeUndefined();
    expect(p.time_since_injection_days).toBe(21);
    expect(p.imaging_depth_um).toBe(150.5);
    expect(p.data_source).toBe('user');
    expect(p.fps).toBe(30);
    expect(p.dataset_hash).toBe('abc');
    expect(p.app_version).toBe('1.2.3');
    expect(p.extra_metadata).toBeUndefined();
  });

  it('records simulated metadata and the demo preset for demo data', () => {
    const p = buildBaseSubmissionPayload(
      FIELDS,
      ctx({ dataSource: 'demo', demoIndicator: 'gcamp6f' }),
    );
    expect(p.data_source).toBe('demo');
    expect(p.indicator).toBe('simulated');
    expect(p.species).toBe('simulated');
    expect(p.brain_region).toBe('simulated');
    expect(p.virus_construct).toBeUndefined();
    expect(p.microscope_type).toBeUndefined();
    expect(p.time_since_injection_days).toBeUndefined();
    expect(p.orcid).toBe('0000-0001-2345-6789');
    expect(p.extra_metadata).toEqual({ demo_preset: 'gcamp6f' });
  });

  it('keeps the bridge source', () => {
    expect(buildBaseSubmissionPayload(FIELDS, ctx({ dataSource: 'bridge' })).data_source).toBe(
      'bridge',
    );
  });
});

describe('hashSubmissionDataset', () => {
  it("returns 'no-data' without data and a stable hash with it", async () => {
    expect(await hashSubmissionDataset(undefined)).toBe('no-data');
    const a = await hashSubmissionDataset(new Float64Array([1, 2, 3]));
    const b = await hashSubmissionDataset([1, 2, 3]);
    expect(a).toMatch(/^[0-9a-f]+$/);
    expect(b).toBe(a);
  });
});
