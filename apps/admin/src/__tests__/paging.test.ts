import { describe, expect, it } from 'vitest';
import { fetchAllPages } from '../lib/paging.ts';

/** A fake PostgREST table with an optional server-side max-rows. */
function table(total: number, serverMax = Infinity) {
  const rows = Array.from({ length: total }, (_, i) => ({ id: total - i }));
  const calls: [number, number][] = [];
  return {
    calls,
    fetchPage: async (from: number, to: number) => {
      calls.push([from, to]);
      return rows.slice(from, Math.min(to + 1, from + serverMax));
    },
  };
}

describe('fetchAllPages', () => {
  it('reads every page past the 1000-row default', async () => {
    const t = table(2500);
    const r = await fetchAllPages(t.fetchPage);
    expect(r.rows).toHaveLength(2500);
    expect(r.truncated).toBe(false);
    expect(t.calls[0]).toEqual([0, 999]);
  });

  it('is not cut short when the server max-rows is below the page size', async () => {
    const t = table(1300, 500);
    const r = await fetchAllPages(t.fetchPage);
    expect(r.rows).toHaveLength(1300);
  });

  it('returns nothing for an empty table', async () => {
    const r = await fetchAllPages(table(0).fetchPage);
    expect(r).toEqual({ rows: [], truncated: false, pages: 1 });
  });

  it('handles an exact multiple of the page size', async () => {
    const r = await fetchAllPages(table(2000).fetchPage, { pageSize: 1000 });
    expect(r.rows).toHaveLength(2000);
    expect(r.pages).toBe(3); // the third page is the empty terminator
  });

  it('flags truncation at maxRows and trims to it', async () => {
    const r = await fetchAllPages(table(5000).fetchPage, { pageSize: 1000, maxRows: 2500 });
    expect(r.truncated).toBe(true);
    expect(r.rows).toHaveLength(2500);
  });

  it('drops duplicates caused by rows inserted between pages', async () => {
    const pages = [[{ id: 3 }, { id: 2 }], [{ id: 2 }, { id: 1 }], []];
    let i = 0;
    const r = await fetchAllPages(async () => pages[i++], {
      pageSize: 2,
      key: (x) => String(x.id),
    });
    expect(r.rows.map((x) => x.id)).toEqual([3, 2, 1]);
  });

  it('propagates a failing page instead of returning partial data', async () => {
    await expect(
      fetchAllPages(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});
