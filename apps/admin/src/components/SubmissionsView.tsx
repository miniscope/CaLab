import { type JSX, createResource, createSignal, createMemo, Show } from 'solid-js';
import { DataTable } from './DataTable.tsx';
import { fetchSubmissions, deleteSubmission, computeOutliers } from '../lib/analytics-queries.ts';
import { dateRange } from '../lib/admin-store.ts';

export function SubmissionsView(): JSX.Element {
  const [submissions, { refetch }] = createResource(dateRange, fetchSubmissions);
  const [filterIndicator, setFilterIndicator] = createSignal('');
  const [filterSpecies, setFilterSpecies] = createSignal('');
  const [filterRegion, setFilterRegion] = createSignal('');
  const [filterSource, setFilterSource] = createSignal('');
  const [showOutliersOnly, setShowOutliersOnly] = createSignal(false);
  const [selectedIds, setSelectedIds] = createSignal<Set<string>>(new Set());

  const outlierIds = createMemo(() => computeOutliers(submissions() ?? []));

  const filtered = createMemo(() => {
    let rows = submissions() ?? [];
    const ind = filterIndicator().toLowerCase();
    const sp = filterSpecies().toLowerCase();
    const reg = filterRegion().toLowerCase();
    const src = filterSource();
    if (ind) rows = rows.filter((r) => r.indicator.toLowerCase().includes(ind));
    if (sp) rows = rows.filter((r) => r.species.toLowerCase().includes(sp));
    if (reg) rows = rows.filter((r) => r.brain_region.toLowerCase().includes(reg));
    if (src) rows = rows.filter((r) => r.data_source === src);
    if (showOutliersOnly()) rows = rows.filter((r) => outlierIds().has(r.id));
    return rows;
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleDelete = async (row: Record<string, any>) => {
    if (!confirm(`Delete submission ${String(row.id).slice(0, 8)}...?`)) return;
    await deleteSubmission(row.id as string);
    refetch();
  };

  const handleBulkDelete = async () => {
    const ids = Array.from(selectedIds());
    if (ids.length === 0) return;
    if (!confirm(`Delete ${ids.length} selected submission(s)?`)) return;
    for (const id of ids) {
      await deleteSubmission(id);
    }
    setSelectedIds(new Set<string>());
    refetch();
  };

  const rowClass = (row: Record<string, unknown>) => {
    return outlierIds().has(row.id as string) ? 'outlier-row' : undefined;
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
        <select
          class="filter-bar__select"
          value={filterSource()}
          onChange={(e) => setFilterSource(e.currentTarget.value)}
        >
          <option value="">All sources</option>
          <option value="user">user</option>
          <option value="demo">demo</option>
          <option value="training">training</option>
          <option value="bridge">bridge</option>
        </select>
        <label class="filter-bar__toggle">
          <input
            type="checkbox"
            checked={showOutliersOnly()}
            onChange={(e) => setShowOutliersOnly(e.currentTarget.checked)}
          />
          Show outliers only
        </label>
      </div>

      <Show when={selectedIds().size > 0}>
        <div class="bulk-toolbar">
          <span class="bulk-toolbar__count">{selectedIds().size} selected</span>
          <button class="bulk-toolbar__delete" onClick={handleBulkDelete}>
            Delete Selected
          </button>
        </div>
      </Show>

      <DataTable
        columns={[
          { key: 'created_at', label: 'Date' },
          { key: 'indicator', label: 'Indicator' },
          { key: 'species', label: 'Species' },
          { key: 'brain_region', label: 'Brain Region' },
          { key: 'data_source', label: 'Source' },
          { key: 'tau_rise', label: 'Tau Rise' },
          { key: 'tau_decay', label: 'Tau Decay' },
          { key: 'lambda', label: 'Lambda' },
          { key: 'sampling_rate', label: 'Samp. Rate' },
          { key: 'app_version', label: 'Version' },
        ]}
        rows={filtered()}
        onDeleteRow={handleDelete}
        selectable
        selectedIds={selectedIds}
        onSelectionChange={setSelectedIds}
        rowClass={rowClass}
      />
    </div>
  );
}
