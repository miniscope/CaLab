import { type JSX, createMemo, createSignal, Show } from 'solid-js';
import { DataTable, type Column, type Row } from './DataTable.tsx';
import { deleteCadeconSubmission, deleteSubmission } from '../lib/analytics-queries.ts';
import { computeCadeconOutliers, computeOutliers } from '../lib/outliers.ts';
import { cadeconSubs, catuneSubs, refresh } from '../lib/admin-store.ts';

type SubmissionApp = 'catune' | 'cadecon';

const COMMON: Column[] = [
  {
    key: 'created_at',
    label: 'Date',
    format: (r) => String(r.created_at).slice(0, 16).replace('T', ' '),
  },
  { key: 'indicator', label: 'Indicator' },
  { key: 'species', label: 'Species' },
  { key: 'brain_region', label: 'Brain region' },
  { key: 'data_source', label: 'Source' },
  { key: 'tau_rise', label: 'Tau rise', align: 'right' },
  { key: 'tau_decay', label: 'Tau decay', align: 'right' },
];
const CATUNE_COLS: Column[] = [
  ...COMMON,
  { key: 'lambda', label: 'Lambda', align: 'right' },
  { key: 'sampling_rate', label: 'Rate', align: 'right' },
  { key: 'app_version', label: 'Version' },
];
const CADECON_COLS: Column[] = [
  ...COMMON,
  { key: 'sampling_rate', label: 'Rate', align: 'right' },
  { key: 'median_alpha', label: 'Med. alpha', align: 'right' },
  { key: 'median_pve', label: 'Med. PVE', align: 'right' },
  { key: 'converged', label: 'Converged' },
  { key: 'app_version', label: 'Version' },
];

export function SubmissionsView(): JSX.Element {
  const [app, setApp] = createSignal<SubmissionApp>('catune');
  const [source, setSource] = createSignal('');
  const [outliersOnly, setOutliersOnly] = createSignal(false);
  const [selected, setSelected] = createSignal<Set<string>>(new Set());
  const [error, setError] = createSignal<string | null>(null);

  const switchApp = (a: SubmissionApp) => {
    setSelected(new Set<string>());
    setApp(a);
  };

  const catuneOutliers = createMemo(() => computeOutliers(catuneSubs()));
  const cadeconOutliers = createMemo(() => computeCadeconOutliers(cadeconSubs()));
  const outliers = () => (app() === 'catune' ? catuneOutliers() : cadeconOutliers());
  const rows = createMemo((): Row[] => {
    let r: Row[] = app() === 'catune' ? catuneSubs() : cadeconSubs();
    if (source()) r = r.filter((x) => x.data_source === source());
    if (outliersOnly()) r = r.filter((x) => outliers().has(x.id as string));
    return r;
  });

  const remove = async (ids: string[]) => {
    setError(null);
    const del = app() === 'catune' ? deleteSubmission : deleteCadeconSubmission;
    const failed: string[] = [];
    for (const id of ids) {
      try {
        await del(id);
      } catch (e) {
        failed.push(`${id.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    setSelected(new Set<string>());
    if (failed.length > 0) setError(`Could not delete ${failed.length}: ${failed.join('; ')}`);
    refresh();
  };

  const rowClass = (row: Row) => (outliers().has(row.id as string) ? 'outlier-row' : undefined);

  return (
    <div class="view">
      <p class="note">
        Submissions follow the date range only (not the app, version or dev filters). Outliers are
        flagged by the 1.5 x IQR rule on tau and sampling rate.
      </p>
      <div class="app-toggle" role="group" aria-label="Submission app">
        <button
          class={`app-toggle__btn${app() === 'catune' ? ' app-toggle__btn--active' : ''}`}
          aria-pressed={app() === 'catune'}
          onClick={() => switchApp('catune')}
        >
          CaTune ({catuneSubs().length})
        </button>
        <button
          class={`app-toggle__btn${app() === 'cadecon' ? ' app-toggle__btn--active' : ''}`}
          aria-pressed={app() === 'cadecon'}
          onClick={() => switchApp('cadecon')}
        >
          CaDecon ({cadeconSubs().length})
        </button>
      </div>
      <div class="filter-bar">
        <label class="filters__field">
          <span>Source</span>
          <select value={source()} onChange={(e) => setSource(e.currentTarget.value)}>
            <option value="">All sources</option>
            <option value="user">user</option>
            <option value="demo">demo</option>
            <option value="training">training</option>
            <option value="bridge">bridge</option>
          </select>
        </label>
        <label class="filters__check">
          <input
            type="checkbox"
            checked={outliersOnly()}
            onChange={(e) => setOutliersOnly(e.currentTarget.checked)}
          />
          Outliers only ({outliers().size})
        </label>
      </div>
      <Show when={error()}>
        <div class="banner banner--error" role="alert">
          {error()}
        </div>
      </Show>
      <Show when={selected().size > 0}>
        <div class="bulk-toolbar">
          <span>{selected().size} selected</span>
          <button
            class="bulk-toolbar__delete"
            onClick={() => {
              if (confirm(`Delete ${selected().size} selected submission(s)?`)) {
                void remove(Array.from(selected()));
              }
            }}
          >
            Delete selected
          </button>
        </div>
      </Show>
      <DataTable
        caption={`${app() === 'catune' ? 'CaTune' : 'CaDecon'} community submissions`}
        columns={app() === 'catune' ? CATUNE_COLS : CADECON_COLS}
        rows={rows()}
        pageSize={25}
        searchable
        defaultSort={{ key: 'created_at', asc: false }}
        onDeleteRow={(row) => {
          if (confirm(`Delete submission ${String(row.id).slice(0, 8)}...?`))
            void remove([row.id as string]);
        }}
        selectable
        selectedIds={selected}
        onSelectionChange={setSelected}
        rowClass={rowClass}
        emptyText="No submissions in this range."
      />
    </div>
  );
}
