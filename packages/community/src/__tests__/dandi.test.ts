import { describe, expect, it, vi } from 'vitest';
import {
  acknowledgementText,
  dandiConfig,
  dandiDownloadUrl,
  dandiFolderUrl,
  dandiViewUrl,
  loadDandiCollection,
} from '../dandi.ts';

const CFG = dandiConfig('000999', 'sandbox')!;

function fakeFetch(routes: Record<string, unknown>) {
  return vi.fn(async (url: string, _init?: RequestInit) => {
    const body = routes[url];
    if (body === undefined) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
}

describe('dandi helpers', () => {
  it('builds a config only for a 6-digit dandiset', () => {
    expect(dandiConfig(undefined, undefined)).toBeNull();
    expect(dandiConfig('12', 'dandi')).toBeNull();
    expect(dandiConfig('000999', undefined)).toEqual({
      dandiset: '000999',
      api: 'https://api.dandiarchive.org/api',
      web: 'https://dandiarchive.org',
    });
    expect(CFG.api).toBe('https://api.sandbox.dandiarchive.org/api');
  });

  it('builds download, view and folder links', () => {
    const a = { asset_id: 'abc', path: 'sub-x/sub-x_ses-1_ophys.nwb', size: 10, version: '0.1' };
    expect(dandiDownloadUrl(CFG, a)).toBe(
      'https://api.sandbox.dandiarchive.org/api/assets/abc/download/',
    );
    const view = new URL(dandiViewUrl(CFG, a));
    expect(view.origin).toBe('https://neurosift.app');
    expect(view.searchParams.get('url')).toBe(dandiDownloadUrl(CFG, a));
    expect(view.searchParams.get('dandisetId')).toBe('000999');
    expect(view.searchParams.get('dandisetVersion')).toBe('0.1');
    expect(dandiFolderUrl(CFG, a.path)).toBe(
      'https://sandbox.dandiarchive.org/dandiset/000999/draft/files?location=sub-x',
    );
  });

  it('loads the published version and adds draft-only assets', async () => {
    const api = CFG.api;
    const f = fakeFetch({
      [`${api}/dandisets/000999/`]: { most_recent_published_version: { version: '0.1' } },
      [`${api}/dandisets/000999/versions/0.1/info/`]: {
        metadata: {
          citation: 'Lab (2026) CaLab donated recordings',
          doi: '10.48324/dandi.000999/0.1',
        },
      },
      [`${api}/dandisets/000999/versions/0.1/assets/?page_size=1000`]: {
        next: null,
        results: [{ asset_id: 'a1', path: 'sub-a/a.nwb', size: 1 }],
      },
      [`${api}/dandisets/000999/versions/draft/assets/?page_size=1000`]: {
        next: null,
        results: [
          { asset_id: 'd1', path: 'sub-a/a.nwb', size: 1 },
          { asset_id: 'd2', path: 'sub-b/b.nwb', size: 2 },
        ],
      },
    });
    const c = await loadDandiCollection(CFG, f);
    expect(c.version).toBe('0.1');
    expect(c.doi).toBe('10.48324/dandi.000999/0.1');
    expect(c.assets.get('sub-a/a.nwb')).toEqual({
      asset_id: 'a1',
      path: 'sub-a/a.nwb',
      size: 1,
      version: '0.1',
    });
    expect(c.assets.get('sub-b/b.nwb')?.version).toBe('draft');
  });

  it('uses the draft when nothing is published yet', async () => {
    const api = CFG.api;
    const f = fakeFetch({
      [`${api}/dandisets/000999/`]: { most_recent_published_version: null },
      [`${api}/dandisets/000999/versions/draft/info/`]: { metadata: { citation: 'draft cite' } },
      [`${api}/dandisets/000999/versions/draft/assets/?page_size=1000`]: {
        next: null,
        results: [{ asset_id: 'd2', path: 'sub-b/b.nwb', size: 2 }],
      },
    });
    const c = await loadDandiCollection(CFG, f);
    expect(c.version).toBe('draft');
    expect(c.doi).toBeNull();
    expect(c.citation).toBe('draft cite');
    expect(c.assets.size).toBe(1);
  });

  it('reports a timed-out DANDI as not reachable', async () => {
    const stalled = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      throw new DOMException('timed out', 'TimeoutError');
    }) as unknown as typeof fetch;
    await expect(loadDandiCollection(CFG, stalled)).rejects.toThrow(/DANDI is not reachable/);
  });

  it('throws a readable error when DANDI answers with an error', async () => {
    await expect(loadDandiCollection(CFG, fakeFetch({}))).rejects.toThrow(/DANDI/);
  });

  it('writes an acknowledgement naming the donor, lab and collection', () => {
    const text = acknowledgementText(
      { credit_name: 'Jane Doe', credit_lab: 'Doe Lab' },
      CFG,
      '10.48324/dandi.000999/0.1',
    );
    expect(text).toBe(
      'Data were contributed by Jane Doe (Doe Lab) to the CaLab donated recordings collection (DANDI:000999, doi:10.48324/dandi.000999/0.1).',
    );
    expect(acknowledgementText({ credit_name: null, credit_lab: 'Doe Lab' }, CFG, null)).toBe(
      'Data were contributed by Doe Lab to the CaLab donated recordings collection (DANDI:000999).',
    );
  });
});
