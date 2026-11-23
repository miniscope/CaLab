// DANDI REST API helpers for the public donation collection
// (apps/cala/docs/data-donation.md, "Browse page"). Public endpoints only, no
// key; DANDI's API and S3 answer CORS for any origin.

export interface DandiConfig {
  dandiset: string;
  api: string;
  web: string;
}

export interface DandiAsset {
  asset_id: string;
  path: string;
  size: number;
  /** The version this asset entry is from: a published version or 'draft'. */
  version: string;
}

export interface DandiCollection {
  version: string;
  citation: string | null;
  doi: string | null;
  /** By asset path. */
  assets: Map<string, DandiAsset>;
}

const INSTANCES = {
  dandi: { api: 'https://api.dandiarchive.org/api', web: 'https://dandiarchive.org' },
  sandbox: {
    api: 'https://api.sandbox.dandiarchive.org/api',
    web: 'https://sandbox.dandiarchive.org',
  },
} as const;

const MAX_PAGES = 50;

/** The collection's config, or null when no (valid) dandiset is set. */
export function dandiConfig(
  dandiset: string | undefined,
  instance: string | undefined,
): DandiConfig | null {
  if (!dandiset || !/^\d{6}$/.test(dandiset)) return null;
  return { dandiset, ...(instance === 'sandbox' ? INSTANCES.sandbox : INSTANCES.dandi) };
}

/** From VITE_DONATION_DANDISET / VITE_DONATION_DANDI_INSTANCE (dandi | sandbox). */
export const donationDandi: DandiConfig | null = dandiConfig(
  import.meta.env.VITE_DONATION_DANDISET,
  import.meta.env.VITE_DONATION_DANDI_INSTANCE,
);

/** A stalled DANDI must not leave the browse page loading forever. */
export const DANDI_TIMEOUT_MS = 15_000;

async function getJson(fetchFn: typeof fetch, url: string): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchFn(url, { signal: AbortSignal.timeout(DANDI_TIMEOUT_MS) });
  } catch (err) {
    throw new Error(`DANDI is not reachable (${err instanceof Error ? err.message : err})`, {
      cause: err,
    });
  }
  if (!res.ok) throw new Error(`DANDI answered ${res.status} for ${url}`);
  return (await res.json()) as Record<string, unknown>;
}

async function listAssets(
  cfg: DandiConfig,
  version: string,
  fetchFn: typeof fetch,
): Promise<DandiAsset[]> {
  const out: DandiAsset[] = [];
  let url: string | null =
    `${cfg.api}/dandisets/${cfg.dandiset}/versions/${version}/assets/?page_size=1000`;
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const body = await getJson(fetchFn, url);
    for (const r of (body.results as Record<string, unknown>[]) ?? []) {
      out.push({
        asset_id: String(r.asset_id),
        path: String(r.path),
        size: Number(r.size),
        version,
      });
    }
    url = typeof body.next === 'string' ? body.next : null;
  }
  return out;
}

/**
 * The collection's most recent published version (else the draft) with its
 * citation and DOI, and every asset by path. Assets that are only in the draft
 * (uploaded after the last published version) are added with version 'draft'.
 */
export async function loadDandiCollection(
  cfg: DandiConfig,
  fetchFn: typeof fetch = fetch,
): Promise<DandiCollection> {
  const ds = await getJson(fetchFn, `${cfg.api}/dandisets/${cfg.dandiset}/`);
  const published = ds.most_recent_published_version as { version?: string } | null;
  const version = published?.version ?? 'draft';
  const info = await getJson(
    fetchFn,
    `${cfg.api}/dandisets/${cfg.dandiset}/versions/${version}/info/`,
  );
  const meta = (info.metadata ?? {}) as { citation?: unknown; doi?: unknown };
  const assets = new Map<string, DandiAsset>();
  for (const a of await listAssets(cfg, version, fetchFn)) assets.set(a.path, a);
  if (version !== 'draft') {
    for (const a of await listAssets(cfg, 'draft', fetchFn)) {
      if (!assets.has(a.path)) assets.set(a.path, a);
    }
  }
  return {
    version,
    citation: typeof meta.citation === 'string' ? meta.citation : null,
    doi: typeof meta.doi === 'string' && version !== 'draft' ? meta.doi : null,
    assets,
  };
}

export function dandiDownloadUrl(cfg: DandiConfig, asset: DandiAsset): string {
  return `${cfg.api}/assets/${asset.asset_id}/download/`;
}

/** Neurosift, the in-browser NWB viewer DANDI links to. */
export function dandiViewUrl(cfg: DandiConfig, asset: DandiAsset): string {
  const q = new URLSearchParams({
    url: dandiDownloadUrl(cfg, asset),
    dandisetId: cfg.dandiset,
    dandisetVersion: asset.version,
  });
  return `https://neurosift.app/nwb?${q}`;
}

/** The asset's folder on the DANDI web page (draft view, which lists every file). */
export function dandiFolderUrl(cfg: DandiConfig, path: string): string {
  const dir = path.slice(0, Math.max(0, path.lastIndexOf('/')));
  return `${cfg.web}/dandiset/${cfg.dandiset}/draft/files?location=${encodeURIComponent(dir)}`;
}

/** The sentence we ask users of a recording to put in their acknowledgements. */
export function acknowledgementText(
  row: { credit_name: string | null; credit_lab: string | null },
  cfg: DandiConfig,
  doi: string | null,
): string {
  const who = row.credit_name
    ? `${row.credit_name}${row.credit_lab ? ` (${row.credit_lab})` : ''}`
    : (row.credit_lab ?? 'the contributing lab');
  const ref = doi ? `DANDI:${cfg.dandiset}, doi:${doi}` : `DANDI:${cfg.dandiset}`;
  return `Data were contributed by ${who} to the CaLab donated recordings collection (${ref}).`;
}
