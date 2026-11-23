/**
 * "Browse donated recordings" on cala's start page: published public donations
 * with Download / View links on DANDI and a ready acknowledgement sentence
 * (apps/cala/docs/data-donation.md, "Browse page"). No sign-in needed.
 */
import { createResource, createSignal, For, Show, type JSX } from 'solid-js';
import {
  acknowledgementText,
  dandiDownloadUrl,
  dandiViewUrl,
  donationDandi,
  listPublicDonations,
  loadDandiCollection,
  type DandiCollection,
} from '@calab/community';
import { distinct, filterRows, joinRows, type BrowseFilter } from '../lib/browse-donations.ts';
import { formatBytes } from '../lib/donation-runner.ts';

async function load() {
  const rows = await listPublicDonations();
  let coll: DandiCollection | null = null;
  let dandiError: string | null = null;
  if (!donationDandi) dandiError = 'The DANDI collection is not set up yet.';
  else {
    try {
      coll = await loadDandiCollection(donationDandi);
    } catch (err) {
      dandiError = err instanceof Error ? err.message : String(err);
    }
  }
  return { rows: joinRows(rows, coll), coll, dandiError };
}

export function BrowseDonationsEntry(): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const [data] = createResource(open, (o) => (o ? load() : undefined));
  const [filter, setFilter] = createSignal<BrowseFilter>({
    species: '',
    indicator: '',
    region: '',
  });
  const [copied, setCopied] = createSignal<string | null>(null);

  const shown = () => filterRows(data()?.rows ?? [], filter());
  const doi = () => data()?.coll?.doi ?? null;

  async function copy(id: string, text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
    } catch {
      window.prompt('Copy this acknowledgement:', text);
    }
  }

  const select = (label: string, key: keyof BrowseFilter, values: string[]) => (
    <label class="cala-browse__filter">
      {label}{' '}
      <select
        value={filter()[key]}
        onChange={(e) => setFilter({ ...filter(), [key]: e.currentTarget.value })}
      >
        <option value="">all</option>
        <For each={values}>{(v) => <option value={v}>{v}</option>}</For>
      </select>
    </label>
  );

  return (
    <section class="cala-donate-entry" data-testid="browse-donations">
      <button type="button" class="cala-donate__link" onClick={() => setOpen((v) => !v)}>
        {open() ? 'Hide donated recordings' : 'Browse donated recordings'}
      </button>
      <Show when={open()}>
        <Show when={!data.loading} fallback={<p class="cala-muted">Loading...</p>}>
          <Show
            when={!data.error}
            fallback={
              <div class="error-card" role="alert">
                {String(data.error?.message ?? data.error)}
              </div>
            }
          >
            <div class="cala-browse__cite" data-testid="browse-cite">
              <strong>How to cite.</strong> If you use these recordings, cite the collection
              {doi() ? ` (doi:${doi()})` : ''} and acknowledge the contributing lab ("Copy
              acknowledgement" below). They are shared under CC BY 4.0.
              <Show when={data()?.coll?.citation}>{(c) => <p class="cala-muted">{c()}</p>}</Show>
            </div>
            <Show when={data()?.dandiError}>
              {(m) => <p class="cala-warning">{m()} Recordings are listed without links.</p>}
            </Show>
            <div class="cala-browse__filters">
              {select('Species', 'species', distinct(data()?.rows ?? [], 'species'))}
              {select('Indicator', 'indicator', distinct(data()?.rows ?? [], 'indicator'))}
              {select('Region', 'region', distinct(data()?.rows ?? [], 'brain_region'))}
            </div>
            <Show
              when={shown().length > 0}
              fallback={<p class="cala-muted">No published recordings yet.</p>}
            >
              <ul class="cala-donate__list">
                <For each={shown()}>
                  {(r) => (
                    <li class="cala-donate__item" data-testid="browse-row">
                      <span>
                        {r.donation.indicator}, {r.donation.species}, {r.donation.brain_region},{' '}
                        {r.donation.scope}{' '}
                        <span class="cala-muted">
                          ({r.donation.n_frames.toLocaleString()} frames at {r.donation.fps} Hz
                          {r.asset ? `, ${formatBytes(r.asset.size)}` : ''}) from{' '}
                          {r.donation.credit_lab ?? 'a donor lab'}
                        </span>
                      </span>
                      <span class="cala-donate__status">
                        <Show when={r.asset && donationDandi ? r.asset : null}>
                          {(a) => (
                            <>
                              <a href={dandiDownloadUrl(donationDandi!, a())}>Download</a>{' '}
                              <a
                                href={dandiViewUrl(donationDandi!, a())}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                View
                              </a>{' '}
                            </>
                          )}
                        </Show>
                        <Show when={donationDandi}>
                          {(cfg) => (
                            <button
                              type="button"
                              class="btn-secondary btn-small"
                              onClick={() =>
                                void copy(
                                  r.donation.id,
                                  acknowledgementText(r.donation, cfg(), doi()),
                                )
                              }
                            >
                              {copied() === r.donation.id ? 'Copied' : 'Copy acknowledgement'}
                            </button>
                          )}
                        </Show>
                      </span>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </Show>
        </Show>
      </Show>
    </section>
  );
}
