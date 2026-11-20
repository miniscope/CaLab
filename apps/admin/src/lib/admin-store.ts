// Admin auth signals, global filters, the loaded dataset and its filtered views.

import { createEffect, createMemo, createSignal, onCleanup, untrack } from 'solid-js';
// user/authLoading come from the shared community store, so the admin app runs
// a single auth subscription (started by initCommunityStore() in index.tsx).
import { user, authLoading } from '@calab/community';
import type { AdminView, EventRow, SessionRow } from './types.ts';
import {
  type Filters,
  applySessionFilters,
  parseHash,
  resolveWindow,
  splitPeriods,
  toHash,
} from './filters.ts';
import { liveSource, TABLES, type Dataset, type TableName } from './analytics-queries.ts';
import { IDLE, runLoad, type TableState } from './loader.ts';
import { probeSchema } from './schema.ts';
import type { CadeconSubmissionRow, SubmissionRow } from './types.ts';
import type { TimeWindow } from './filters.ts';
import { discoverApps, discoverVersions, eventsOf } from './metrics.ts';
import { compareVersions } from './stats.ts';
import { FIXTURE_MODE, fixtureOptions } from './fixture/flag.ts';

function isAdmin(): boolean {
  return user()?.app_metadata?.role === 'admin';
}

const initial = parseHash(typeof location === 'undefined' ? '' : location.hash);
const [view, setView] = createSignal<AdminView>(initial.view);
const [filters, setFilters] = createSignal<Filters>(initial.filters);
const [nowMs, setNowMs] = createSignal(Date.now());

const win = createMemo(() => resolveWindow(filters(), nowMs()));

// ---- progressive loading ----
// Tables load independently (loader.ts): the UI renders once sessions arrive and
// events keep streaming in. Row arrays grow in place; `rev` signals a chunk.

const [tables, setTables] = createSignal<Record<TableName, TableState>>({
  sessions: IDLE,
  events: IDLE,
  catune: IDLE,
  cadecon: IDLE,
});
const [rev, bumpRev] = createSignal(0, { equals: false });
const rows: Record<TableName, unknown[]> = { sessions: [], events: [], catune: [], cadecon: [] };
let generation = 0;
let controller: AbortController | null = null;
const lastBump = { t: 0, timer: 0 as ReturnType<typeof setTimeout> | 0 };

/** Throttle chunk updates so a 150k-row events stream does not recompute every page. */
function scheduleBump(final: boolean): void {
  const now = Date.now();
  if (final || now - lastBump.t > 600) {
    if (lastBump.timer) clearTimeout(lastBump.timer);
    lastBump.timer = 0;
    lastBump.t = now;
    bumpRev((n) => n + 1);
  } else if (!lastBump.timer) {
    lastBump.timer = setTimeout(() => {
      lastBump.timer = 0;
      lastBump.t = Date.now();
      bumpRev((n) => n + 1);
    }, 600);
  }
}

function cancelLoad(): void {
  generation++;
  controller?.abort();
  controller = null;
}

async function startLoad(w: TimeWindow): Promise<void> {
  cancelLoad();
  const gen = generation;
  const ctrl = (controller = new AbortController());
  for (const k of Object.keys(rows) as TableName[]) rows[k] = [];
  setTables({ sessions: IDLE, events: IDLE, catune: IDLE, cadecon: IDLE });
  bumpRev((n) => n + 1);
  const source = FIXTURE_MODE
    ? (await import('./fixture/synthetic.ts')).fixtureSource(Date.now(), fixtureOptions())
    : await liveSource();
  if (gen !== generation) return;
  await runLoad(
    source,
    w,
    {
      onTable(name, state, chunk) {
        if (gen !== generation) return;
        rows[name] = chunk;
        setTables((t) => ({ ...t, [name]: state }));
        scheduleBump(state.status !== 'loading');
      },
    },
    ctrl.signal,
    { log: (m) => console.info(m) },
  );
}

/** Stop every running table, keeping the rows already loaded. */
function stopLoading(): void {
  controller?.abort();
}

// Fetch only once the viewer is a verified admin (or in fixture mode); before
// that RLS would just return nothing.
const ready = () => FIXTURE_MODE || (!authLoading() && isAdmin());
// Reload only when the fetched span changes, not on app/version/dev filter clicks.
const loadKey = createMemo(() => {
  const w = win();
  return `${w.fetchStart}|${w.fetchEnd}|${w.curStart}|${w.curEnd}`;
});
createEffect(() => {
  if (!ready()) return;
  loadKey();
  untrack(() => void startLoad(win()));
});
onCleanup(cancelLoad);

const anyLoading = () => Object.values(tables()).some((t) => t.status === 'loading');
const sessionsRows = createMemo((): SessionRow[] => {
  rev();
  return rows.sessions as SessionRow[];
});
const eventsRows = createMemo((): EventRow[] => {
  rev();
  return rows.events as EventRow[];
});
const latest = createMemo((): Dataset | undefined => {
  const t = tables();
  if (t.sessions.status === 'idle') return undefined;
  rev();
  const sessions = rows.sessions as SessionRow[];
  const events = rows.events as EventRow[];
  const ids = new Set(sessions.map((s) => s.id));
  return {
    sessions,
    events,
    catune: rows.catune as SubmissionRow[],
    cadecon: rows.cadecon as CadeconSubmissionRow[],
    truncated: (Object.keys(t) as TableName[])
      .filter((k) => t[k].truncated)
      .map((k) => TABLES[k].label),
    orphanEvents: events.filter((e) => !ids.has(e.session_id)).length,
    fetchedAt: Date.now(),
  };
});
/** Same shape the views always used: latest rows plus load flags. */
const dataset = {
  get latest(): Dataset | undefined {
    return latest();
  },
  get loading(): boolean {
    return anyLoading();
  },
};

const rawSessions = (): SessionRow[] => sessionsRows();
const schema = createMemo(() => probeSchema(sessionsRows(), eventsRows()));
const apps = createMemo(() => discoverApps(rawSessions()));
const versions = createMemo(() =>
  discoverVersions(rawSessions(), filters().app).sort(compareVersions).reverse(),
);
const scoped = createMemo(() => applySessionFilters(rawSessions(), filters()));
const periods = createMemo(() => splitPeriods(scoped(), win()));
const cur = () => periods().cur;
const prev = () => (win().prevStart === null ? null : periods().prev);
const events = createMemo((): EventRow[] => eventsOf(cur(), eventsRows()));
/** Cur + prev sessions after filters: the basis for first-seen computations. */
const scopedAll = () => scoped();

// Same period without the version filter, for version-over-version comparison.
const scopedAnyVersion = createMemo(() =>
  applySessionFilters(rawSessions(), { ...filters(), version: 'all' }),
);
const curAnyVersion = createMemo(() => splitPeriods(scopedAnyVersion(), win()).cur);
const eventsAnyVersion = createMemo((): EventRow[] => eventsOf(curAnyVersion(), eventsRows()));

/** Submissions follow the date window only (they carry no dev flag or session). */
function inWindow<T extends { created_at: string }>(rows: T[], from: number, to: number): T[] {
  return rows.filter((r) => {
    const t = Date.parse(r.created_at);
    return t >= from && t < to;
  });
}
const catuneSubs = createMemo(() =>
  inWindow(dataset.latest?.catune ?? [], win().curStart, win().curEnd),
);
const cadeconSubs = createMemo(() =>
  inWindow(dataset.latest?.cadecon ?? [], win().curStart, win().curEnd),
);
const prevSubs = createMemo(() => {
  const w = win();
  if (w.prevStart === null || w.prevEnd === null) return null;
  const d = dataset.latest;
  return (
    inWindow(d?.catune ?? [], w.prevStart, w.prevEnd).length +
    inWindow(d?.cadecon ?? [], w.prevStart, w.prevEnd).length
  );
});

function refresh(): void {
  setNowMs(Date.now());
}

// Keep the URL hash in step with the state (replace, so Back does not step
// through every filter click) and follow manual hash edits.
if (typeof window !== 'undefined') {
  createEffect(() => {
    const h = toHash(view(), filters());
    if (location.hash !== h)
      history.replaceState(null, '', `${location.pathname}${location.search}${h}`);
  });
  window.addEventListener('hashchange', () => {
    const s = parseHash(location.hash);
    setView(s.view);
    setFilters(s.filters);
  });
}

export {
  user,
  authLoading,
  isAdmin,
  view as activeView,
  setView as setActiveView,
  filters,
  setFilters,
  win,
  dataset,
  schema,
  tables,
  stopLoading,
  eventsRows,
  cur,
  prev,
  events,
  scopedAll,
  curAnyVersion,
  eventsAnyVersion,
  catuneSubs,
  cadeconSubs,
  prevSubs,
  apps,
  versions,
  refresh,
  nowMs,
};
