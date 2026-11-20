// Moderation of raw data donations (apps/cala/docs/data-donation.md, phase 4).
// Rows come straight from `cala_donations` (RLS returns every row to an admin);
// review and benchmark actions go through donation-service.

import { type JSX, For, Show, createMemo, createResource, createSignal } from 'solid-js';
import { listDonations, type DonationRow } from '@calab/community';
import { DataTable, type Column, type Row } from './DataTable.tsx';
import { DonationDrawer } from './DonationDrawer.tsx';
import {
  DONATION_STATUSES,
  type StatusFilter,
  countByStatus,
  filterDonations,
  formatBytes,
  formatCredit,
} from '../lib/donations.ts';
import { FIXTURE_MODE } from '../lib/fixture/flag.ts';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const yesNo = (v: unknown) => (v ? 'yes' : 'no');

const COLUMNS: Column[] = [
  {
    key: 'created_at',
    label: 'Created',
    format: (r) => String(r.created_at).slice(0, 16).replace('T', ' '),
  },
  { key: 'status', label: 'Status' },
  { key: 'scope', label: 'Scope' },
  { key: 'indicator', label: 'Indicator' },
  { key: 'brain_region', label: 'Region' },
  {
    key: 'declared_bytes',
    label: 'Size',
    align: 'right',
    format: (r) => formatBytes(r.declared_bytes),
  },
  {
    key: 'n_frames',
    label: 'Frames',
    align: 'right',
    format: (r) => Number(r.n_frames).toLocaleString('en-US'),
  },
  { key: 'license', label: 'License' },
  { key: 'contact_ok', label: 'Contact', format: (r) => yesNo(r.contact_ok) },
  { key: 'credit_name', label: 'Credit', format: (r) => formatCredit(r as DonationRow) },
  { key: 'in_benchmark', label: 'Benchmark', format: (r) => yesNo(r.in_benchmark) },
];

async function load(): Promise<DonationRow[]> {
  // The fixture build has no backend; show an empty table rather than an error.
  if (FIXTURE_MODE) return [];
  return listDonations();
}

export function DonationsView(): JSX.Element {
  const [rows, { refetch }] = createResource(load);
  const [status, setStatus] = createSignal<StatusFilter>('uploaded');
  const [openId, setOpenId] = createSignal<string | null>(null);

  const all = () => rows.latest ?? [];
  const counts = createMemo(() => countByStatus(all()));
  const visible = createMemo(() => filterDonations(all(), status()));
  // Follow the row through refetches so the drawer shows the new status.
  const open = createMemo(() => all().find((r) => r.id === openId()) ?? null);

  return (
    <div class="view">
      <p class="note">
        Raw recordings donated from cala. Approve moves the files to the lab's pull queue, reject
        deletes them. Preview decodes the first chunk before you decide. Newest first; not affected
        by the date or app filters.
      </p>
      <div class="filter-bar">
        <label class="filters__field">
          <span>Status</span>
          <select
            value={status()}
            onChange={(e) => setStatus(e.currentTarget.value as StatusFilter)}
          >
            <option value="all">All ({all().length})</option>
            <For each={DONATION_STATUSES}>
              {(s) => (
                <option value={s}>
                  {s} ({counts()[s]})
                </option>
              )}
            </For>
          </select>
        </label>
        <button class="btn-secondary" disabled={rows.loading} onClick={() => void refetch()}>
          {rows.loading ? 'Loading...' : 'Reload'}
        </button>
      </div>
      <Show when={rows.error !== undefined}>
        <div class="banner banner--error" role="alert">
          Could not load donations: {errorText(rows.error)}
        </div>
      </Show>
      <DataTable
        caption="Data donations"
        columns={COLUMNS}
        rows={visible() as Row[]}
        pageSize={25}
        searchable
        defaultSort={{ key: 'created_at', asc: false }}
        onRowClick={(r) => setOpenId(String(r.id))}
        emptyText={rows.loading ? 'Loading donations...' : 'No donations with this status.'}
      />
      <Show when={open()}>
        {(d) => (
          <DonationDrawer
            donation={d()}
            onClose={() => setOpenId(null)}
            onChanged={() => void refetch()}
          />
        )}
      </Show>
    </div>
  );
}
