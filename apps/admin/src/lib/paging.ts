// Keyset-paged reads for PostgREST. Supabase caps one select at the project's
// `max-rows` (1000 by default) and silently returns only those rows, so a big
// table needs several requests. OFFSET paging is O(offset) per page on the
// server (and sorts ties), which made deep reads of analytics_events take
// minutes; keyset paging asks for "rows older than the last one I have" and
// each page costs the same.

export const PAGE_SIZE = 1000;
export const PAGE_TIMEOUT_MS = 30_000;

export interface Cursor {
  /** Exactly as the server returned it (microsecond precision matters for ties). */
  created_at: string;
  id: string | number;
}

export interface KeysetRow {
  created_at: string;
  id: string | number;
}

export class PageError extends Error {
  constructor(
    readonly table: string,
    readonly page: number,
    message: string,
  ) {
    super(`${table} page ${page}: ${message}`);
  }
}

export interface KeysetResult<T> {
  rows: T[];
  /** The row cap was reached while more rows may exist. */
  truncated: boolean;
  pages: number;
  /** Stopped by the caller's signal; `rows` is what had loaded. */
  cancelled: boolean;
  /** A page failed after its retry; `rows` is what had loaded. */
  error: PageError | null;
}

export interface KeysetOptions<T> {
  table?: string;
  pageSize?: number;
  maxRows?: number;
  timeoutMs?: number;
  /** Extra attempts per page after the first failure. */
  retries?: number;
  signal?: AbortSignal;
  /** Called after each page with the accumulating (shared, in-place) row array. */
  onProgress?: (rows: T[], pages: number) => void;
}

function abortError(): Error {
  return new DOMException('aborted', 'AbortError');
}

/** Run one request with a timeout; a late response is ignored. */
async function attempt<R>(
  fn: (signal: AbortSignal) => Promise<R>,
  timeoutMs: number,
  outer?: AbortSignal,
): Promise<R> {
  const ctrl = new AbortController();
  const onOuter = () => ctrl.abort();
  outer?.addEventListener('abort', onOuter);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    outer?.addEventListener('abort', () => reject(abortError()));
  });
  try {
    return await Promise.race([fn(ctrl.signal), guard]);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onOuter);
  }
}

/**
 * Read every page, newest first. `fetchPage(cursor, signal)` returns the next
 * rows strictly after `cursor` in (created_at desc, id desc) order, or the
 * first rows for a null cursor. It never throws to the caller: a page that
 * fails (after `retries`) ends the read with `error` set and the rows so far.
 * Rows are de-duplicated by id. The loop ends on an empty page (a server
 * max-rows below the page size cannot end it early).
 */
export async function fetchAllKeyset<T extends KeysetRow>(
  fetchPage: (cursor: Cursor | null, signal: AbortSignal) => Promise<T[]>,
  opts: KeysetOptions<T> = {},
): Promise<KeysetResult<T>> {
  const table = opts.table ?? 'table';
  const maxRows = opts.maxRows ?? Infinity;
  const timeoutMs = opts.timeoutMs ?? PAGE_TIMEOUT_MS;
  const retries = opts.retries ?? 1;
  const rows: T[] = [];
  const seen = new Set<string>();
  let cursor: Cursor | null = null;
  let pages = 0;
  const done = (extra: Partial<KeysetResult<T>>): KeysetResult<T> => ({
    rows,
    truncated: false,
    pages,
    cancelled: false,
    error: null,
    ...extra,
  });

  for (;;) {
    if (opts.signal?.aborted) return done({ cancelled: true });
    let page: T[] | undefined;
    let lastErr: unknown;
    for (let tries = 0; tries <= retries; tries++) {
      try {
        page = await attempt((s) => fetchPage(cursor, s), timeoutMs, opts.signal);
        break;
      } catch (e) {
        if (opts.signal?.aborted) return done({ cancelled: true });
        lastErr = e;
      }
    }
    if (!page) {
      const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
      return done({ error: new PageError(table, pages + 1, msg) });
    }
    pages++;
    if (page.length === 0) return done({});
    for (const row of page) {
      const k = String(row.id);
      if (seen.has(k)) continue;
      seen.add(k);
      rows.push(row);
    }
    const last = page[page.length - 1];
    if (cursor && cursor.created_at === last.created_at && cursor.id === last.id) {
      return done({
        error: new PageError(table, pages, 'cursor did not advance (filter ignored?)'),
      });
    }
    cursor = { created_at: last.created_at, id: last.id };
    opts.onProgress?.(rows, pages);
    if (rows.length >= maxRows) {
      rows.length = maxRows;
      return done({ truncated: true });
    }
  }
}
