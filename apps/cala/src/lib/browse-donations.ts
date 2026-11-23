// Rows of the "Browse donated recordings" list: published public donations
// (Supabase view) joined with their DANDI asset. A row without an asset still
// shows (DANDI down, or the file not visible yet), only without links.
import type { DandiAsset, DandiCollection, PublicDonation } from '@calab/community';

export interface BrowseFilter {
  species: string;
  indicator: string;
  region: string;
}

export interface BrowseRow {
  donation: PublicDonation;
  asset: DandiAsset | null;
}

export function joinRows(rows: PublicDonation[], coll: DandiCollection | null): BrowseRow[] {
  return rows.map((donation) => ({
    donation,
    asset: coll?.assets.get(donation.dandi_path) ?? null,
  }));
}

export function filterRows(rows: BrowseRow[], f: BrowseFilter): BrowseRow[] {
  return rows.filter(
    ({ donation: d }) =>
      (!f.species || d.species === f.species) &&
      (!f.indicator || d.indicator === f.indicator) &&
      (!f.region || d.brain_region === f.region),
  );
}

export function distinct(
  rows: BrowseRow[],
  key: 'species' | 'indicator' | 'brain_region',
): string[] {
  return [...new Set(rows.map((r) => r.donation[key]))].sort();
}
