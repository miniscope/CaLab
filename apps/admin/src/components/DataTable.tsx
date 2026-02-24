import { type JSX, type Accessor, createSignal, createMemo, For, Show } from 'solid-js';

interface Column {
  key: string;
  label: string;
  bar?: boolean; // show inline CSS bar
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRow = Record<string, any>;

interface DataTableProps {
  columns: Column[];
  rows: AnyRow[];
  maxBarValue?: number;
  onDeleteRow?: (row: AnyRow) => void;
  selectable?: boolean;
  selectedIds?: Accessor<Set<string>>;
  onSelectionChange?: (ids: Set<string>) => void;
  rowClass?: (row: AnyRow) => string | undefined;
}

export function DataTable(props: DataTableProps): JSX.Element {
  const [sortKey, setSortKey] = createSignal<string>(props.columns[0]?.key ?? '');
  const [sortAsc, setSortAsc] = createSignal(true);

  const sorted = createMemo(() => {
    const key = sortKey();
    const asc = sortAsc();
    return [...props.rows].sort((a, b) => {
      const va = a[key];
      const vb = b[key];
      if (typeof va === 'number' && typeof vb === 'number') {
        return asc ? va - vb : vb - va;
      }
      return asc
        ? String(va ?? '').localeCompare(String(vb ?? ''))
        : String(vb ?? '').localeCompare(String(va ?? ''));
    });
  });

  const maxVal = createMemo(() => {
    if (props.maxBarValue) return props.maxBarValue;
    const barCol = props.columns.find((c) => c.bar);
    if (!barCol) return 1;
    return Math.max(1, ...props.rows.map((r) => Number(r[barCol.key]) || 0));
  });

  const handleSort = (key: string) => {
    if (sortKey() === key) {
      setSortAsc((prev) => !prev);
    } else {
      setSortKey(key);
      setSortAsc(false);
    }
  };

  const allSelected = createMemo(() => {
    if (!props.selectable || !props.selectedIds) return false;
    const sel = props.selectedIds();
    return props.rows.length > 0 && props.rows.every((r) => sel.has(r.id as string));
  });

  const toggleAll = () => {
    if (!props.onSelectionChange) return;
    if (allSelected()) {
      props.onSelectionChange(new Set());
    } else {
      props.onSelectionChange(new Set(props.rows.map((r) => r.id as string)));
    }
  };

  const toggleRow = (id: string) => {
    if (!props.onSelectionChange || !props.selectedIds) return;
    const next = new Set(props.selectedIds());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    props.onSelectionChange(next);
  };

  return (
    <div class="data-table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <Show when={props.selectable}>
              <th class="data-table__th data-table__th--checkbox">
                <input
                  type="checkbox"
                  class="data-table__checkbox"
                  checked={allSelected()}
                  onChange={toggleAll}
                />
              </th>
            </Show>
            <For each={props.columns}>
              {(col) => (
                <th class="data-table__th" onClick={() => handleSort(col.key)}>
                  {col.label}
                  <Show when={sortKey() === col.key}>
                    <span class="data-table__sort">{sortAsc() ? ' \u25B2' : ' \u25BC'}</span>
                  </Show>
                </th>
              )}
            </For>
            <Show when={props.onDeleteRow}>
              <th class="data-table__th"></th>
            </Show>
          </tr>
        </thead>
        <tbody>
          <For each={sorted()}>
            {(row) => (
              <tr class={props.rowClass?.(row) ?? undefined}>
                <Show when={props.selectable}>
                  <td class="data-table__td">
                    <input
                      type="checkbox"
                      class="data-table__checkbox"
                      checked={props.selectedIds?.().has(row.id as string) ?? false}
                      onChange={() => toggleRow(row.id as string)}
                    />
                  </td>
                </Show>
                <For each={props.columns}>
                  {(col) => (
                    <td class="data-table__td">
                      <Show when={col.bar} fallback={String(row[col.key] ?? '')}>
                        <div class="data-table__bar-cell">
                          <span>{String(row[col.key] ?? '')}</span>
                          <div
                            class="data-table__bar"
                            style={{
                              width: `${Math.round(((Number(row[col.key]) || 0) / maxVal()) * 100)}%`,
                            }}
                          />
                        </div>
                      </Show>
                    </td>
                  )}
                </For>
                <Show when={props.onDeleteRow}>
                  <td class="data-table__td">
                    <button class="data-table__delete" onClick={() => props.onDeleteRow!(row)}>
                      Delete
                    </button>
                  </td>
                </Show>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  );
}
