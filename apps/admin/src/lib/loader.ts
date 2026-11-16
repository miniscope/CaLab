// Progressive loading: sessions and submissions first, events afterwards in
// the background. Each table reports its own status and row chunks, so the UI
// can render as soon as sessions arrive and never waits for events.

import type { CadeconSubmissionRow, EventRow, SessionRow, SubmissionRow } from './types.ts';
import type { TimeWindow } from './filters.ts';
import { type PageSource, type TableName, TABLES } from './analytics-queries.ts';
import { fetchAllKeyset, type KeysetRow } from './paging.ts';

export type LoadStatus = 'idle' | 'loading' | 'done' | 'error' | 'cancelled';

export interface TableState {
  status: LoadStatus;
  rows: number;
  pages: number;
  ms: number;
  truncated: boolean;
  /** Which page failed and why. */
  error: string | null;
}

export const IDLE: TableState = {
  status: 'idle',
  rows: 0,
  pages: 0,
  ms: 0,
  truncated: false,
  error: null,
};

/** Row caps per table; hitting one shows an explicit banner (newest rows are kept). */
export const MAX_ROWS: Record<TableName, number> = {
  sessions: 100_000,
  events: 150_000,
  catune: 50_000,
  cadecon: 50_000,
};

export interface LoadedRows {
  sessions: SessionRow[];
  events: EventRow[];
  catune: SubmissionRow[];
  cadecon: CadeconSubmissionRow[];
}

export interface LoadCallbacks {
  /** Called per page and on every status change. `rows` is shared and grows in place. */
  onTable(name: TableName, state: TableState, rows: unknown[]): void;
}

export interface LoadOptions {
  pageTimeoutMs?: number;
  retries?: number;
  log?: (msg: string) => void;
}

/**
 * Windows: sessions and submissions cover the previous and current period (for
 * deltas and first-seen); events cover only the current period, since every
 * events view joins to current-period sessions.
 */
export function tableRange(name: TableName, w: TimeWindow): { from: number; to: number } {
  return name === 'events'
    ? { from: w.curStart, to: w.curEnd }
    : { from: w.fetchStart, to: w.fetchEnd };
}

async function loadTable(
  name: TableName,
  source: PageSource,
  w: TimeWindow,
  cb: LoadCallbacks,
  signal: AbortSignal,
  opts: LoadOptions,
): Promise<void> {
  const t0 = Date.now();
  const rowsRef: { current: unknown[] } = { current: [] };
  const state = (over: Partial<TableState>): TableState => ({
    status: 'loading',
    rows: rowsRef.current.length,
    pages: 0,
    ms: Date.now() - t0,
    truncated: false,
    error: null,
    ...over,
  });
  cb.onTable(name, state({}), rowsRef.current);
  const res = await fetchAllKeyset<KeysetRow>(source.pageFn(name, tableRange(name, w)), {
    table: TABLES[name].label,
    maxRows: MAX_ROWS[name],
    timeoutMs: opts.pageTimeoutMs,
    retries: opts.retries,
    signal,
    onProgress: (rows, pages) => {
      rowsRef.current = rows;
      cb.onTable(name, state({ pages }), rows);
    },
  });
  rowsRef.current = res.rows;
  const status: LoadStatus = res.error ? 'error' : res.cancelled ? 'cancelled' : 'done';
  const final = state({
    status,
    pages: res.pages,
    truncated: res.truncated,
    error: res.error?.message ?? null,
  });
  opts.log?.(
    `[admin] ${name}: ${res.rows.length} rows, ${res.pages} pages, ${final.ms} ms` +
      (res.truncated ? ' (row cap reached)' : '') +
      (res.error ? ` ERROR ${res.error.message}` : '') +
      (res.cancelled ? ' (cancelled)' : ''),
  );
  cb.onTable(name, final, res.rows);
}

/**
 * Load all four tables. Sessions and both submission tables start together;
 * events start as soon as sessions finish (or fail) and run in the background.
 * Resolves when everything has finished, failed or been cancelled; never rejects.
 */
export async function runLoad(
  source: PageSource,
  w: TimeWindow,
  cb: LoadCallbacks,
  signal: AbortSignal,
  opts: LoadOptions = {},
): Promise<void> {
  const subs = Promise.all([
    loadTable('catune', source, w, cb, signal, opts),
    loadTable('cadecon', source, w, cb, signal, opts),
  ]);
  await loadTable('sessions', source, w, cb, signal, opts);
  await Promise.all([subs, loadTable('events', source, w, cb, signal, opts)]);
}
