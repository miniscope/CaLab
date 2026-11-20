import { describe, expect, it } from 'vitest';
import { resolveWindow, DEFAULT_FILTERS } from '../lib/filters.ts';
import { type PageSource, type TableName, supabaseSource } from '../lib/analytics-queries.ts';
import { IDLE, runLoad, tableRange, type TableState } from '../lib/loader.ts';
import { computeOverview } from '../lib/metrics.ts';
import { probeSchema } from '../lib/schema.ts';
import { T0, event, session } from './helpers.ts';

const W = resolveWindow(DEFAULT_FILTERS, T0);

/** Minimal PostgREST-like client: records the query and evaluates it over rows. */
function fakeSupabase(tables: Record<string, Record<string, unknown>[]>) {
  const log: {
    table: string;
    columns: string;
    or: string | null;
    limit: number;
    range: boolean;
  }[] = [];
  return {
    log,
    from(table: string) {
      const q = {
        columns: '',
        gte: '',
        lt: '',
        or: null as string | null,
        limit: 1000,
        range: false,
      };
      const b = {
        select: (c: string) => ((q.columns = c), b),
        gte: (_c: string, v: string) => ((q.gte = v), b),
        lt: (_c: string, v: string) => ((q.lt = v), b),
        or: (v: string) => ((q.or = v), b),
        order: () => b,
        limit: (n: number) => ((q.limit = n), b),
        range: () => ((q.range = true), b),
        abortSignal: () => b,
        then(res: (v: { data: unknown[]; error: null }) => void) {
          log.push({ table, columns: q.columns, or: q.or, limit: q.limit, range: q.range });
          let rows = (tables[table] ?? []).filter(
            (r) => (r.created_at as string) >= q.gte && (r.created_at as string) < q.lt,
          );
          if (q.or) {
            const m = q.or.match(
              /^created_at\.lt\.(.+?),and\(created_at\.eq\.(.+?),id\.lt\.(.+)\)$/,
            )!;
            rows = rows.filter(
              (r) =>
                (r.created_at as string) < m[1] || (r.created_at === m[2] && String(r.id) < m[3]),
            );
          }
          rows = rows.sort(
            (a, c) =>
              (c.created_at as string).localeCompare(a.created_at as string) ||
              String(c.id).localeCompare(String(a.id)),
          );
          res({ data: rows.slice(0, q.limit), error: null });
        },
      };
      return b;
    },
  };
}

describe('supabaseSource (keyset query shape)', () => {
  const rows = Array.from({ length: 7 }, (_, i) => ({
    id: `id${i}`,
    created_at: new Date(W.curStart + 1000 + (i % 3) * 1000).toISOString(), // many ties
  }));
  it('uses a keyset filter with an id tiebreak, never an offset, and select(*) for analytics tables', async () => {
    const fake = fakeSupabase({ analytics_sessions: rows, analytics_events: [] });
    const src = supabaseSource(fake as never, 3);
    const states: Partial<Record<TableName, TableState>> = {};
    await runLoad(src, W, { onTable: (n, s) => (states[n] = s) }, new AbortController().signal);
    expect(states.sessions).toMatchObject({ status: 'done', rows: 7 });
    const sessionCalls = fake.log.filter((c) => c.table === 'analytics_sessions');
    expect(sessionCalls.length).toBeGreaterThan(2);
    expect(sessionCalls.every((c) => !c.range && c.limit === 3)).toBe(true);
    expect(sessionCalls[0].or).toBeNull();
    expect(sessionCalls[1].or).toMatch(/^created_at\.lt\..+,and\(created_at\.eq\..+,id\.lt\..+\)$/);
    expect(sessionCalls.every((c) => c.columns === '*')).toBe(true);
    expect(
      fake.log.filter((c) => c.table === 'analytics_events').every((c) => c.columns === '*'),
    ).toBe(true);
    const sub = fake.log.find((c) => c.table === 'catune_submissions')!;
    expect(sub.columns).not.toBe('*');
  });

  it('events use the current period only; sessions include the previous period', () => {
    expect(tableRange('events', W)).toEqual({ from: W.curStart, to: W.curEnd });
    expect(tableRange('sessions', W)).toEqual({ from: W.fetchStart, to: W.fetchEnd });
    expect(W.fetchStart).toBeLessThan(W.curStart);
  });
});

describe('runLoad (progressive)', () => {
  function source(over: Partial<Record<TableName, () => Promise<never[]>>>): PageSource {
    return {
      pageFn: (name) => {
        let served = false;
        return async () => {
          if (over[name]) return over[name]!();
          if (served) return [];
          served = true;
          return [{ id: `${name}1`, created_at: '2026-01-01T00:00:00Z' }] as never[];
        };
      },
    };
  }

  it('finishes sessions and submissions before events, and reports per-table status', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let eventsCalls = 0;
    const events: string[] = [];
    const p = runLoad(
      source({
        events: async () => {
          if (eventsCalls++ === 0) {
            await gate;
            return [{ id: 'e1', created_at: '2026-01-01T00:00:00Z' }] as never[];
          }
          return [];
        },
      }),
      W,
      { onTable: (n, s) => events.push(`${n}:${s.status}`) },
      new AbortController().signal,
    );
    await new Promise((r) => setTimeout(r, 20));
    // Events are still pending while everything else is done.
    expect(events).toContain('sessions:done');
    expect(events).toContain('catune:done');
    expect(events).toContain('events:loading');
    expect(events).not.toContain('events:done');
    release();
    await p;
    expect(events).toContain('events:done');
    expect(events.indexOf('sessions:done')).toBeLessThan(events.indexOf('events:done'));
  });

  it('surfaces a failing sessions read as an error state (not silence) and still loads events', async () => {
    const states: Partial<Record<TableName, TableState>> = {};
    await runLoad(
      source({
        sessions: async () => {
          throw new Error('column analytics_sessions.is_anonymous does not exist');
        },
      }),
      W,
      { onTable: (n, s) => (states[n] = s) },
      new AbortController().signal,
      { retries: 0 },
    );
    expect(states.sessions?.status).toBe('error');
    expect(states.sessions?.error).toBe(
      'Sessions page 1: column analytics_sessions.is_anonymous does not exist',
    );
    expect(states.events?.status).toBe('done');
  });

  it('cancel keeps loaded rows and marks tables cancelled; IDLE is the starting state', async () => {
    const ctrl = new AbortController();
    const states: Partial<Record<TableName, TableState>> = {};
    await runLoad(
      source({
        events: async () => {
          ctrl.abort();
          return [{ id: 'e1', created_at: '2026-01-01T00:00:00Z' }] as never[];
        },
      }),
      W,
      { onTable: (n, s) => (states[n] = s) },
      ctrl.signal,
    );
    expect(states.events?.status).toBe('cancelled');
    expect(IDLE.status).toBe('idle');
  });

  it('logs per-table timings', async () => {
    const lines: string[] = [];
    await runLoad(source({}), W, { onTable: () => {} }, new AbortController().signal, {
      log: (m) => lines.push(m),
    });
    expect(lines.some((l) => /^\[admin\] sessions: 1 rows, 2 pages, \d+ ms/.test(l))).toBe(true);
  });
});

describe('schema degradation', () => {
  it('reports a missing is_anonymous and shows signed-in as unknown, not 0 and not all', () => {
    const rows = [session(), session()].map((s) => {
      const { is_anonymous: _d, ...rest } = s;
      void _d;
      return rest;
    });
    const report = probeSchema(rows as never, []);
    expect(report.anonKnown).toBe(false);
    expect(report.messages[0]).toBe(
      'analytics_sessions.is_anonymous is missing on this database (migration 008): signed-in vs anonymous cannot be told apart.',
    );
    const o = computeOverview(rows as never, report.anonKnown);
    expect(o.signedIn).toBeNull();
    expect(o.browsers).toBe(2); // browsers = distinct user_id still works
    expect(computeOverview([session()]).signedIn).toBe(0);
  });

  it('flags other missing columns and is silent for a complete schema or no rows', () => {
    const s = session();
    const { country_code: _c, ...noGeo } = s;
    void _c;
    expect(probeSchema([noGeo as never], []).messages.join(' ')).toMatch(/country_code is missing/);
    expect(probeSchema([s], [event(s.id, 'x')]).messages).toEqual([]);
    expect(probeSchema([], []).messages).toEqual([]);
  });
});
