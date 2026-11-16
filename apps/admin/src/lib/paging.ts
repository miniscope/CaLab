// Paged reads for PostgREST. Supabase caps a single select at the project's
// `max-rows` (1000 by default) and returns the first rows silently, so an
// unpaged query truncates every total without any error.

export const PAGE_SIZE = 1000;
export const DEFAULT_MAX_ROWS = 200_000;

export interface PagedResult<T> {
  rows: T[];
  /** True when `maxRows` was reached while more rows may still exist. */
  truncated: boolean;
  pages: number;
}

export interface PagingOptions<T> {
  pageSize?: number;
  maxRows?: number;
  /** Row identity, used to drop duplicates when rows shift between pages. */
  key?: (row: T) => string;
}

/**
 * Fetch every page until the server returns an empty one. `fetchPage(from, to)`
 * is an inclusive range, like PostgREST `.range()`. The next offset advances by
 * the number of rows actually returned, so a server `max-rows` smaller than the
 * page size cannot end the loop early. Rows are expected newest-first: a row
 * inserted mid-read shifts later rows down (a duplicate, removed through `key`)
 * and never skips one.
 */
export async function fetchAllPages<T>(
  fetchPage: (from: number, to: number) => Promise<T[]>,
  opts: PagingOptions<T> = {},
): Promise<PagedResult<T>> {
  const pageSize = Math.max(1, opts.pageSize ?? PAGE_SIZE);
  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
  const rows: T[] = [];
  const seen = opts.key ? new Set<string>() : null;
  let from = 0;
  let pages = 0;
  for (;;) {
    const page = await fetchPage(from, from + pageSize - 1);
    pages++;
    if (page.length === 0) return { rows, truncated: false, pages };
    from += page.length;
    for (const row of page) {
      if (seen && opts.key) {
        const k = opts.key(row);
        if (seen.has(k)) continue;
        seen.add(k);
      }
      rows.push(row);
    }
    if (rows.length >= maxRows) {
      return { rows: rows.slice(0, maxRows), truncated: true, pages };
    }
  }
}
