import { type JSX, createResource, createSignal, createMemo } from 'solid-js';
import { DataTable } from './DataTable.tsx';
import { fetchSubmissions, deleteSubmission } from '../lib/analytics-queries.ts';

export function SubmissionsView(): JSX.Element {
  const [submissions, { refetch }] = createResource(fetchSubmissions);
  const [filterIndicator, setFilterIndicator] = createSignal('');
  const [filterSpecies, setFilterSpecies] = createSignal('');
  const [filterRegion, setFilterRegion] = createSignal('');

  const filtered = createMemo(() => {
    let rows = submissions() ?? [];
    const ind = filterIndicator().toLowerCase();
    const sp = filterSpecies().toLowerCase();
    const reg = filterRegion().toLowerCase();
    if (ind) rows = rows.filter((r) => r.indicator.toLowerCase().includes(ind));
    if (sp) rows = rows.filter((r) => r.species.toLowerCase().includes(sp));
    if (reg) rows = rows.filter((r) => r.brain_region.toLowerCase().includes(reg));
    return rows;
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleDelete = async (row: Record<string, any>) => {
    if (!confirm(`Delete submission ${String(row.id).slice(0, 8)}...?`)) return;
    await deleteSubmission(row.id as string);
    refetch();
  };

  return (
    <div class="view">
      <h2 class="view__title">Community Submissions</h2>

      <div class="filter-bar">
        <input
          type="text"
          placeholder="Filter indicator..."
          value={filterIndicator()}
          onInput={(e) => setFilterIndicator(e.currentTarget.value)}
        />
        <input
          type="text"
          placeholder="Filter species..."
          value={filterSpecies()}
          onInput={(e) => setFilterSpecies(e.currentTarget.value)}
        />
        <input
          type="text"
          placeholder="Filter region..."
          value={filterRegion()}
          onInput={(e) => setFilterRegion(e.currentTarget.value)}
        />
      </div>

      <DataTable
        columns={[
          { key: 'created_at', label: 'Date' },
          { key: 'indicator', label: 'Indicator' },
          { key: 'species', label: 'Species' },
          { key: 'brain_region', label: 'Brain Region' },
          { key: 'data_source', label: 'Source' },
          { key: 'app_version', label: 'Version' },
        ]}
        rows={filtered()}
        onDeleteRow={handleDelete}
      />
    </div>
  );
}
