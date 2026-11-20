import { createSignal, For, Show, type JSX } from 'solid-js';

export interface LegendItem {
  label: string;
  color: string;
}

export interface TableView {
  columns: string[];
  rows: (string | number)[][];
}

interface Props {
  title: string;
  subtitle?: string;
  legend?: LegendItem[];
  actions?: JSX.Element;
  /** Accessible alternative to the plot; shown on demand. */
  table?: TableView;
  /** Dim the content while data reloads. */
  loading?: boolean;
  children: JSX.Element;
}

export function Legend(props: { items: LegendItem[] }): JSX.Element {
  return (
    <ul class="legend" aria-label="Legend">
      <For each={props.items}>
        {(it) => (
          <li class="legend__item">
            <span class="legend__swatch" style={{ background: it.color }} />
            {it.label}
          </li>
        )}
      </For>
    </ul>
  );
}

export function ChartCard(props: Props): JSX.Element {
  const [showTable, setShowTable] = createSignal(false);
  return (
    <section class="card" classList={{ 'card--loading': props.loading }}>
      <header class="card__head">
        <div>
          <h3 class="card__title">{props.title}</h3>
          <Show when={props.subtitle}>
            <p class="card__sub">{props.subtitle}</p>
          </Show>
        </div>
        <div class="card__actions">
          {props.actions}
          <Show when={props.table}>
            <button
              class="link-btn"
              aria-expanded={showTable()}
              onClick={() => setShowTable((v) => !v)}
            >
              {showTable() ? 'Hide table' : 'Table'}
            </button>
          </Show>
        </div>
      </header>
      <Show when={props.legend && props.legend.length > 1}>
        <Legend items={props.legend!} />
      </Show>
      <Show
        when={!showTable()}
        fallback={
          <div class="data-table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <For each={props.table!.columns}>
                    {(c) => <th class="data-table__th">{c}</th>}
                  </For>
                </tr>
              </thead>
              <tbody>
                <For each={props.table!.rows}>
                  {(r) => (
                    <tr>
                      <For each={r}>
                        {(c, i) => (
                          <td class={`data-table__td${i() > 0 ? ' num' : ''}`}>{String(c)}</td>
                        )}
                      </For>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        }
      >
        {props.children}
      </Show>
    </section>
  );
}

export function Empty(props: { children?: JSX.Element; text?: string }): JSX.Element {
  return <p class="empty">{props.children ?? props.text ?? 'No data for this filter.'}</p>;
}
