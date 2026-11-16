import { type JSX, createMemo, createSignal, For } from 'solid-js';
import {
  type ExportTable,
  cadeconSubmissionTable,
  catuneSubmissionTable,
  columnDocsCSV,
  downloadText,
  eventTable,
  runTable,
  sessionTable,
  tableToCSV,
  tableToJSON,
} from '../lib/export.ts';
import { buildCala } from '../lib/cala.ts';
import { cadeconSubs, catuneSubs, cur, events, filters, win } from '../lib/admin-store.ts';
import { utcDay, DAY_MS } from '../lib/filters.ts';
import { fmtNum } from '../lib/stats.ts';

export function ExportPanel(): JSX.Element {
  const [docsFor, setDocsFor] = createSignal<string>('sessions');
  const stamp = () => {
    const f = filters();
    const w = win();
    return `${f.app}_${w.curStart > 0 ? utcDay(w.curStart) : 'start'}_to_${utcDay(w.curEnd - DAY_MS)}`;
  };
  const tables = createMemo(() => {
    const cala = buildCala(cur(), events());
    return [
      { key: 'sessions', table: sessionTable(cur()) },
      { key: 'events', table: eventTable(events(), cur()) },
      { key: 'runs', table: runTable(cala.runs) },
    ] as { key: string; table: ExportTable }[];
  });
  const subTables = createMemo(() => [
    { key: 'catune', file: 'catune-submissions', table: catuneSubmissionTable(catuneSubs()) },
    { key: 'cadecon', file: 'cadecon-submissions', table: cadeconSubmissionTable(cadeconSubs()) },
  ]);
  const save = (key: string, t: ExportTable, kind: 'csv' | 'json') => {
    const name = `calab-${key}-${stamp()}`;
    if (kind === 'csv') downloadText(tableToCSV(t), `${name}.csv`, 'text/csv');
    else downloadText(tableToJSON(t), `${name}.json`, 'application/json');
  };
  const docs = () => tables().find((t) => t.key === docsFor())?.table;

  return (
    <div class="view">
      <p class="view__desc">
        Exports use the filters above (app, UTC range, version, dev builds). Browser ids are
        six-character hashes; no user_id, IP address or account identity is exported. Cells that
        start with = + or @ are prefixed with a quote so spreadsheets do not run them.
      </p>
      <div class="export-list">
        <For each={tables()}>
          {(t) => (
            <div class="export-row">
              <div>
                <strong>{t.table.title}</strong>
                <span class="export-row__n">{fmtNum(t.table.rows.length)} rows</span>
              </div>
              <div class="export-row__btns">
                <button class="btn-secondary" onClick={() => save(t.key, t.table, 'csv')}>
                  CSV
                </button>
                <button class="btn-secondary" onClick={() => save(t.key, t.table, 'json')}>
                  JSON
                </button>
                <button
                  class="btn-secondary"
                  onClick={() =>
                    downloadText(columnDocsCSV(t.table), `calab-${t.key}-columns.csv`, 'text/csv')
                  }
                >
                  Column docs
                </button>
              </div>
            </div>
          )}
        </For>
        <For each={subTables()}>
          {(t) => (
            <div class="export-row">
              <div>
                <strong>{t.table.title}</strong>
                <span class="export-row__n">
                  {fmtNum(t.table.rows.length)} rows (date range only)
                </span>
              </div>
              <div class="export-row__btns">
                <button class="btn-secondary" onClick={() => save(t.file, t.table, 'csv')}>
                  CSV
                </button>
                <button class="btn-secondary" onClick={() => save(t.file, t.table, 'json')}>
                  JSON
                </button>
              </div>
            </div>
          )}
        </For>
      </div>

      <h2 class="view__title">Columns</h2>
      <div class="app-toggle" role="group" aria-label="Export table">
        <For each={tables()}>
          {(t) => (
            <button
              class={`app-toggle__btn${docsFor() === t.key ? ' app-toggle__btn--active' : ''}`}
              aria-pressed={docsFor() === t.key}
              onClick={() => setDocsFor(t.key)}
            >
              {t.table.title}
            </button>
          )}
        </For>
      </div>
      <dl class="coldocs">
        <For each={docs()?.columns}>
          {(c) => (
            <>
              <dt>
                <code>{c.name}</code>
              </dt>
              <dd>{c.doc}</dd>
            </>
          )}
        </For>
      </dl>
    </div>
  );
}
