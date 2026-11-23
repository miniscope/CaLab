import { describe, expect, it } from 'vitest';
import type { DandiCollection, PublicDonation } from '@calab/community';
import { distinct, filterRows, joinRows } from '../lib/browse-donations.ts';

function pd(over: Partial<PublicDonation>): PublicDonation {
  return {
    id: 'x',
    published_at: '2026-11-20T00:00:00Z',
    indicator: 'GCaMP8m',
    species: 'mouse',
    brain_region: 'M1',
    expression: null,
    preparation: null,
    behavior: null,
    scope: 'UCLA v4',
    fps: 20,
    width: 600,
    height: 600,
    n_frames: 1000,
    bytes_per_pixel: 1,
    depth_um: null,
    subject_sex: 'F',
    subject_age: 'P90D',
    genotype: null,
    credit_name: 'Jane Doe',
    credit_lab: 'Doe Lab',
    dandi_path: 'sub-a/a.nwb',
    ...over,
  };
}

const COLL: DandiCollection = {
  version: '0.1',
  citation: 'cite',
  doi: '10.48324/dandi.000999/0.1',
  assets: new Map([
    ['sub-a/a.nwb', { asset_id: 'a1', path: 'sub-a/a.nwb', size: 5, version: '0.1' }],
  ]),
};

describe('browse donations', () => {
  it('joins rows with their DANDI asset; unknown paths and no collection give no asset', () => {
    const rows = [pd({ id: '1' }), pd({ id: '2', dandi_path: 'sub-b/b.nwb' })];
    const joined = joinRows(rows, COLL);
    expect(joined[0].asset?.asset_id).toBe('a1');
    expect(joined[1].asset).toBeNull();
    expect(joinRows(rows, null).every((r) => r.asset === null)).toBe(true);
  });

  it('filters by species, indicator and region; empty filter keeps all', () => {
    const joined = joinRows(
      [pd({ id: '1' }), pd({ id: '2', species: 'rat', brain_region: 'CA1' })],
      COLL,
    );
    const all = { species: '', indicator: '', region: '' };
    expect(filterRows(joined, all)).toHaveLength(2);
    expect(filterRows(joined, { ...all, species: 'rat' }).map((r) => r.donation.id)).toEqual(['2']);
    expect(filterRows(joined, { ...all, region: 'M1' }).map((r) => r.donation.id)).toEqual(['1']);
  });

  it('lists distinct sorted values for the filters', () => {
    const joined = joinRows([pd({ species: 'rat' }), pd({ species: 'mouse' }), pd({})], null);
    expect(distinct(joined, 'species')).toEqual(['mouse', 'rat']);
  });
});
