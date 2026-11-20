import {
  type Accessor,
  type JSX,
  createEffect,
  createMemo,
  createSignal,
  For,
  Show,
} from 'solid-js';

export interface Column {
  key: string;
  label: string;
  /** Inline bar scaled to the column maximum. */
  bar?: boolean;
  align?: 'left' | 'right';
  /** Display text; defaults to String(row[key]). Never HTML. */
  format?: (row: Row) => string;
}

// Rows are heterogeneous records; column keys are dynamic per table instance.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;

interface Props {
  columns: Column[];
  rows: Row[];
  /** Screen-reader name of the table. */
  caption: string;
  pageSize?: number;
  searchable?: boolean;
  emptyText?: string;
  defaultSort?: { key: string; asc: boolean };
  onRowClick?: (row: Row) => void;
  onDeleteRow?: (row: Row) => void;
  selectable?: boolean;
  selectedIds?: Accessor<Set<string>>;
  onSelectionChange?: (ids: Set<string>) => void;
  rowClass?: (row: Row) => string | undefined;
}

export function compareCells(a: unknown, b: unknown): number {
  const na = a === null || a === undefined || (typeof a === 'number' && Number.isNaN(a));
  const nb = b === null || b === undefined || (typeof b === 'number' && Number.isNaN(b));
  if (na || nb) return na === nb ? 0 : na ? 1 : -1; // missing values sort last
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

export function DataTable(props: Props): JSX.Element {
  // The caller owns the column list (static); seed sort once, then the user owns it.
  // eslint-disable-next-line solid/reactivity
  const [sortKey, setSortKey] = createSignal(props.defaultSort?.key ?? props.columns[0]?.key ?? '');
  const [sortAsc, setSortAsc] = createSignal(props.defaultSort?.asc ?? false);
  const [page, setPage] = createSignal(0);
  const [query, setQuery] = createSignal('');

  const text = (row: Row, c: Column) => (c.format ? c.format(row) : String(row[c.key] ?? ''));

  const filtered = createMemo(() => {
    const q = query().trim().toLowerCase();
    if (!q) return props.rows;
    return props.rows.filter((r) =>
      props.columns.some((c) => text(r, c).toLowerCase().includes(q)),
    );
  });

  const sorted = createMemo(() => {
    const key = sortKey();
    const dir = sortAsc() ? 1 : -1;
    return [...filtered()].sort((a, b) => {
      const c = compareCells(a[key], b[key]);
      // Missing values stay last in both directions.
      const missing = a[key] == null || b[key] == null;
      return missing ? c : c * dir;
    });
  });

  const size = () => props.pageSize ?? Infinity;
  const pages = () => (size() === Infinity ? 1 : Math.max(1, Math.ceil(sorted().length / size())));
  createEffect(() => {
    if (page() >= pages()) setPage(pages() - 1);
  });
  const visible = createMemo(() =>
    size() === Infinity ? sorted() : sorted().slice(page() * size(), page() * size() + size()),
  );

  const maxOf = (key: string) => Math.max(1, ...props.rows.map((r) => Number(r[key]) || 0));

  const handleSort = (key: string) => {
    if (sortKey() === key) setSortAsc((p) => !p);
    else {
      setSortKey(key);
      setSortAsc(false);
    }
    setPage(0);
  };

  const idOf = (r: Row) => String(r.id);
  const allSelected = createMemo(() => {
    const sel = props.selectedIds?.();
    return !!sel && visible().length > 0 && visible().every((r) => sel.has(idOf(r)));
  });
  const toggleAll = () => {
    const next = new Set(props.selectedIds?.() ?? []);
    for (const r of visible()) {
      if (allSelected()) next.delete(idOf(r));
      else next.add(idOf(r));
    }
    props.onSelectionChange?.(next);
  };
  const toggleRow = (id: string) => {
    const next = new Set(props.selectedIds?.() ?? []);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    props.onSelectionChange?.(next);
  };

  const ariaSort = (key: string) =>
    sortKey() === key ? (sortAsc() ? 'ascending' : 'descending') : 'none';

  return (
    <div class="table-block">
      <Show when={props.searchable}>
        <input
          class="table-search"
          type="search"
          placeholder="Search table..."
          aria-label={`Search ${props.caption}`}
          value={query()}
          onInput={(e) => {
            setQuery(e.currentTarget.value);
            setPage(0);
          }}
        />
      </Show>
      <div class="data-table-wrap">
        <table class="data-table">
          <caption class="sr-only">{props.caption}</caption>
          <thead>
            <tr>
              <Show when={props.selectable}>
                <th class="data-table__th data-table__th--checkbox">
                  <input
                    type="checkbox"
                    aria-label="Select all rows on this page"
                    checked={allSelected()}
                    onChange={toggleAll}
                  />
                </th>
              </Show>
              <For each={props.columns}>
                {(col) => (
                  <th
                    class={`data-table__th${col.align === 'right' || col.bar ? ' num' : ''}`}
                    aria-sort={ariaSort(col.key)}
                  >
                    <button class="th-btn" onClick={() => handleSort(col.key)}>
                      {col.label}
                      <span class="data-table__sort" aria-hidden="true">
                        {sortKey() === col.key ? (sortAsc() ? ' ▲' : ' ▼') : ''}
                      </span>
                    </button>
                  </th>
                )}
              </For>
              <Show when={props.onDeleteRow}>
                <th class="data-table__th" />
              </Show>
            </tr>
          </thead>
          <tbody>
            <For each={visible()}>
              {(row) => (
                <tr
                  class={`${props.rowClass?.(row) ?? ''}${props.onRowClick ? ' row--click' : ''}`}
                  tabindex={props.onRowClick ? 0 : undefined}
                  onClick={() => props.onRowClick?.(row)}
                  onKeyDown={(e) => {
                    if (props.onRowClick && (e.key === 'Enter' || e.key === ' ')) {
                      e.preventDefault();
                      props.onRowClick(row);
                    }
                  }}
                >
                  <Show when={props.selectable}>
                    <td class="data-table__td">
                      <input
                        type="checkbox"
                        aria-label={`Select row ${idOf(row).slice(0, 8)}`}
                        checked={props.selectedIds?.().has(idOf(row)) ?? false}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => toggleRow(idOf(row))}
                      />
                    </td>
                  </Show>
                  <For each={props.columns}>
                    {(col) => (
                      <td class={`data-table__td${col.align === 'right' || col.bar ? ' num' : ''}`}>
                        <Show when={col.bar} fallback={text(row, col) || '-'}>
                          <div class="data-table__bar-cell">
                            <span>{text(row, col)}</span>
                            <div class="data-table__track">
                              <div
                                class="data-table__bar"
                                style={{
                                  width: `${Math.round(((Number(row[col.key]) || 0) / maxOf(col.key)) * 100)}%`,
                                }}
                              />
                            </div>
                          </div>
                        </Show>
                      </td>
                    )}
                  </For>
                  <Show when={props.onDeleteRow}>
                    <td class="data-table__td">
                      <button
                        class="data-table__delete"
                        onClick={(e) => {
                          e.stopPropagation();
                          props.onDeleteRow!(row);
                        }}
                      >
                        Delete
                      </button>
                    </td>
                  </Show>
                </tr>
              )}
            </For>
          </tbody>
        </table>
        <Show when={visible().length === 0}>
          <p class="empty">{props.emptyText ?? 'No rows for this filter.'}</p>
        </Show>
      </div>
      <Show when={pages() > 1}>
        <div class="pager">
          <button
            class="btn-secondary"
            disabled={page() === 0}
            onClick={() => setPage((p) => p - 1)}
          >
            Previous
          </button>
          <span>
            Page {page() + 1} of {pages()} ({sorted().length} rows)
          </span>
          <button
            class="btn-secondary"
            disabled={page() >= pages() - 1}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </button>
        </div>
      </Show>
    </div>
  );
}
