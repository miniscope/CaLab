import { type Accessor, type JSX, For, Match, Show, Switch } from 'solid-js';
import type { TableName } from '../lib/analytics-queries.ts';
import { TABLES } from '../lib/analytics-queries.ts';
import type { TableState } from '../lib/loader.ts';
/** Progress counts are shown in full ("48,000"), not compacted. */
const fmtNum = (n: number) => n.toLocaleString('en-US');

const ORDER: TableName[] = ['sessions', 'events', 'catune', 'cadecon'];

export interface DataGateProps {
  tables: Accessor<Record<TableName, TableState>>;
  /** Schema warnings (missing columns). */
  schemaMessages: Accessor<string[]>;
  orphanEvents: Accessor<number>;
  /** Sessions currently matching the filters. */
  matching: Accessor<number>;
  needsSessions: boolean;
  needsEvents: boolean;
  onStop: () => void;
  onSevenDays: () => void;
  onReset: () => void;
  children: JSX.Element;
}

function describe(name: TableName, t: TableState): string {
  const label = TABLES[name].label;
  const n = fmtNum(t.rows);
  switch (t.status) {
    case 'loading':
      return `${label}: ${n} so far...`;
    case 'done':
      return `${label}: ${n}${t.truncated ? ' (capped)' : ''}`;
    case 'error':
      return `${label}: failed after ${n}`;
    case 'cancelled':
      return `${label}: stopped at ${n}`;
    default:
      return `${label}: waiting`;
  }
}

/**
 * Everything around a view: load progress, per-table errors, row-cap and schema
 * banners, and the loading / empty states. It never blocks on events and never
 * hides an error behind "Loading".
 */
export function DataGate(props: DataGateProps): JSX.Element {
  const t = () => props.tables();
  const anyLoading = () => ORDER.some((k) => t()[k].status === 'loading');
  const failed = () => ORDER.filter((k) => t()[k].status === 'error');
  const capped = () => ORDER.filter((k) => t()[k].truncated);
  const sessionsReady = () =>
    t().sessions.status !== 'idle' && (t().sessions.rows > 0 || t().sessions.status !== 'loading');
  const eventsPartial = () =>
    props.needsEvents && t().events.status !== 'done' && t().events.status !== 'idle';

  return (
    <>
      <Show when={failed().length > 0}>
        <div class="banner banner--error" role="alert">
          <For each={failed()}>
            {(k) => (
              <div>
                Could not finish loading {TABLES[k].label.toLowerCase()}: {t()[k].error}. Showing
                the {fmtNum(t()[k].rows)} rows that loaded. Use Refresh to retry.
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={capped().length > 0}>
        <div class="banner banner--warn" role="alert">
          <For each={capped()}>
            {(k) => (
              <div>
                {TABLES[k].label} reached the {fmtNum(t()[k].rows)}-row limit: only the newest rows
                are shown and totals are lower bounds. Narrow the date range.
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={props.schemaMessages().length > 0}>
        <div class="banner banner--warn" role="status">
          <For each={props.schemaMessages()}>{(m) => <div>{m}</div>}</For>
        </div>
      </Show>
      <Show when={anyLoading()}>
        <div class="loadline" role="status" aria-live="polite">
          <span>
            <For each={ORDER}>
              {(k, i) => <span>{(i() > 0 ? ' · ' : '') + describe(k, t()[k])}</span>}
            </For>
          </span>
          <span class="loadline__btns">
            <button class="link-btn" onClick={() => props.onStop()}>
              Stop
            </button>
            <button class="link-btn" onClick={() => props.onSevenDays()}>
              Load 7 days instead
            </button>
          </span>
        </div>
      </Show>
      <Show when={props.orphanEvents() > 0 && !anyLoading() && t().sessions.status === 'done'}>
        <p class="note">
          {fmtNum(props.orphanEvents())} events belong to sessions that started before the loaded
          range and are not attributed to an app.
        </p>
      </Show>
      <Switch>
        <Match when={!sessionsReady() && failed().length === 0}>
          <p class="empty" role="status">
            Loading analytics... {describe('sessions', t().sessions)}
          </p>
        </Match>
        <Match
          when={!sessionsReady() || (t().sessions.status === 'error' && t().sessions.rows === 0)}
        >
          <p class="empty">No session data could be loaded (see the error above).</p>
        </Match>
        <Match
          when={props.needsSessions && t().sessions.status === 'done' && props.matching() === 0}
        >
          <div class="empty empty--block" role="status">
            <p>No sessions match these filters.</p>
            <button class="btn-secondary" onClick={() => props.onReset()}>
              Reset filters and show all time
            </button>
          </div>
        </Match>
        <Match when={true}>
          <Show when={eventsPartial()}>
            <p class="note" role="status">
              {t().events.status === 'loading'
                ? `Events are still loading (${fmtNum(t().events.rows)} so far): the numbers below are partial and update as they arrive.`
                : `Events are incomplete (${t().events.status}): the numbers below only cover ${fmtNum(t().events.rows)} events.`}
            </p>
          </Show>
          <div class="gate" classList={{ 'gate--loading': anyLoading() }} aria-busy={anyLoading()}>
            {props.children}
          </div>
        </Match>
      </Switch>
    </>
  );
}
