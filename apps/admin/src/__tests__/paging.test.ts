import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Cursor, fetchAllKeyset } from '../lib/paging.ts';

interface Row {
  id: number;
  created_at: string;
}

/** In-memory table honouring keyset semantics: newest first, ties by id desc. */
function table(rows: Row[], serverMax = Infinity) {
  const sorted = [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);
  const calls: (Cursor | null)[] = [];
  return {
    calls,
    sorted,
    fetchPage: async (cursor: Cursor | null, size = 3) => {
      calls.push(cursor);
      const after = cursor
        ? sorted.filter(
            (r) =>
              r.created_at < cursor.created_at ||
              (r.created_at === cursor.created_at && r.id < (cursor.id as number)),
          )
        : sorted;
      return after.slice(0, Math.min(size, serverMax));
    },
  };
}
const mk = (n: number, ts: (i: number) => string): Row[] =>
  Array.from({ length: n }, (_, i) => ({ id: i + 1, created_at: ts(i) }));

afterEach(() => vi.useRealTimers());

describe('fetchAllKeyset', () => {
  it('reads every row with no offset, advancing the cursor from the last row', async () => {
    const t = table(mk(10, (i) => `2026-01-${String(10 - i).padStart(2, '0')}T00:00:00Z`));
    const r = await fetchAllKeyset((c) => t.fetchPage(c, 4));
    expect(r.rows).toHaveLength(10);
    expect(r.error).toBeNull();
    expect(t.calls[0]).toBeNull();
    expect(t.calls[1]).toEqual({ created_at: t.sorted[3].created_at, id: t.sorted[3].id });
  });

  it('loses no row and repeats none when a page boundary falls inside identical timestamps', async () => {
    const same = '2026-01-01T00:00:00.123456+00:00';
    const t = table(mk(11, () => same));
    const r = await fetchAllKeyset((c) => t.fetchPage(c, 3));
    expect(r.rows.map((x) => x.id).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 11 }, (_, i) => i + 1),
    );
  });

  it('is not cut short when the server max-rows is below the page size', async () => {
    const t = table(
      mk(25, (i) => `2026-01-01T00:${String(59 - i).padStart(2, '0')}:00Z`),
      2,
    );
    const r = await fetchAllKeyset((c) => t.fetchPage(c, 10));
    expect(r.rows).toHaveLength(25);
  });

  it('copes with rows inserted at the top mid-read (a shifting window)', async () => {
    const base = mk(8, (i) => `2026-01-0${8 - i}T00:00:00Z`);
    let n = 0;
    const r = await fetchAllKeyset(async (c) => {
      if (n++ === 1) base.push({ id: 99, created_at: '2026-02-01T00:00:00Z' });
      const live = table(base);
      return live.fetchPage(c, 3);
    });
    // The new newest row is above the cursor, so it is simply not part of this read.
    expect(r.rows.map((x) => x.id).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('dedupes if the server repeats a row', async () => {
    const pages: Row[][] = [
      [
        { id: 3, created_at: '2026-01-03T00:00:00Z' },
        { id: 2, created_at: '2026-01-02T00:00:00Z' },
      ],
      [
        { id: 2, created_at: '2026-01-02T00:00:00Z' },
        { id: 1, created_at: '2026-01-01T00:00:00Z' },
      ],
      [],
    ];
    let i = 0;
    const r = await fetchAllKeyset(async () => pages[i++]);
    expect(r.rows.map((x) => x.id)).toEqual([3, 2, 1]);
  });

  it('returns nothing for an empty table', async () => {
    const r = await fetchAllKeyset(async () => []);
    expect(r).toMatchObject({
      rows: [],
      truncated: false,
      cancelled: false,
      error: null,
      pages: 1,
    });
  });

  it('flags truncation at maxRows and trims to it', async () => {
    const t = table(mk(50, (i) => `2026-01-01T00:${String(59 - i).padStart(2, '0')}:00Z`));
    const r = await fetchAllKeyset((c) => t.fetchPage(c, 10), { maxRows: 25 });
    expect(r.truncated).toBe(true);
    expect(r.rows).toHaveLength(25);
  });

  it('reports progress per page with a growing shared array', async () => {
    const t = table(mk(9, (i) => `2026-01-0${9 - i}T00:00:00Z`));
    const seen: number[] = [];
    await fetchAllKeyset((c) => t.fetchPage(c, 3), {
      onProgress: (rows) => seen.push(rows.length),
    });
    expect(seen).toEqual([3, 6, 9]);
  });

  it('retries a failing page once, then succeeds', async () => {
    const t = table(mk(4, (i) => `2026-01-0${4 - i}T00:00:00Z`));
    let fail = true;
    const r = await fetchAllKeyset(async (c) => {
      if (c === null && fail) {
        fail = false;
        throw new Error('flaky');
      }
      return t.fetchPage(c, 10);
    });
    expect(r.error).toBeNull();
    expect(r.rows).toHaveLength(4);
  });

  it('keeps the rows loaded and names the table and page when a page keeps failing', async () => {
    const t = table(mk(6, (i) => `2026-01-0${6 - i}T00:00:00Z`));
    const r = await fetchAllKeyset(
      async (c) => {
        if (c !== null) throw new Error('column analytics_sessions.is_anonymous does not exist');
        return t.fetchPage(c, 3);
      },
      { table: 'Sessions' },
    );
    expect(r.rows).toHaveLength(3);
    expect(r.error?.message).toBe(
      'Sessions page 2: column analytics_sessions.is_anonymous does not exist',
    );
  });

  it('times out a hung page, retries once, then surfaces the timeout', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const p = fetchAllKeyset(
      () => {
        calls++;
        return new Promise<Row[]>(() => {});
      },
      { table: 'Events', timeoutMs: 30_000, retries: 1 },
    );
    await vi.advanceTimersByTimeAsync(31_000);
    await vi.advanceTimersByTimeAsync(31_000);
    const r = await p;
    expect(calls).toBe(2);
    expect(r.error?.message).toBe('Events page 1: timed out after 30 s');
    expect(r.rows).toEqual([]);
  });

  it('stops on cancel and keeps what loaded', async () => {
    const ctrl = new AbortController();
    const t = table(mk(9, (i) => `2026-01-0${9 - i}T00:00:00Z`));
    const r = await fetchAllKeyset((c) => t.fetchPage(c, 3), {
      signal: ctrl.signal,
      onProgress: (rows) => {
        if (rows.length >= 6) ctrl.abort();
      },
    });
    expect(r.cancelled).toBe(true);
    expect(r.rows).toHaveLength(6);
    expect(r.error).toBeNull();
  });

  it('stops with an error if the server ignores the cursor instead of looping forever', async () => {
    const same = [{ id: 1, created_at: '2026-01-01T00:00:00Z' }];
    const r = await fetchAllKeyset(async () => same, { table: 'Sessions' });
    expect(r.error?.message).toMatch(/cursor did not advance/);
  });
});
