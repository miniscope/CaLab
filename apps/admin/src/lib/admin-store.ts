// Admin auth signals, global filters, the loaded dataset and its filtered views.

import { createEffect, createMemo, createResource, createSignal } from 'solid-js';
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
import { fetchDataset, type Dataset } from './analytics-queries.ts';
import { discoverApps, discoverVersions, eventsOf } from './metrics.ts';
import { compareVersions } from './stats.ts';
import { FIXTURE_MODE } from './fixture/flag.ts';

function isAdmin(): boolean {
  return user()?.app_metadata?.role === 'admin';
}

const initial = parseHash(typeof location === 'undefined' ? '' : location.hash);
const [view, setView] = createSignal<AdminView>(initial.view);
const [filters, setFilters] = createSignal<Filters>(initial.filters);
const [nowMs, setNowMs] = createSignal(Date.now());

const win = createMemo(() => resolveWindow(filters(), nowMs()));

async function load(w: { fetchStart: number; fetchEnd: number }): Promise<Dataset> {
  if (FIXTURE_MODE) {
    // Removed from production bundles: FIXTURE_MODE is constant false there.
    const m = await import('./fixture/synthetic.ts');
    return m.makeFixture(Date.now(), 7, w);
  }
  return fetchDataset(w);
}

// Fetch only once the viewer is a verified admin (or in fixture mode); before
// that RLS would just return nothing.
const ready = () => FIXTURE_MODE || (!authLoading() && isAdmin());
const [dataset, { refetch }] = createResource(
  () => (ready() ? { fetchStart: win().fetchStart, fetchEnd: win().fetchEnd } : false),
  load,
);

const rawSessions = (): SessionRow[] => dataset.latest?.sessions ?? [];
const apps = createMemo(() => discoverApps(rawSessions()));
const versions = createMemo(() =>
  discoverVersions(rawSessions(), filters().app).sort(compareVersions).reverse(),
);
const scoped = createMemo(() => applySessionFilters(rawSessions(), filters()));
const periods = createMemo(() => splitPeriods(scoped(), win()));
const cur = () => periods().cur;
const prev = () => (win().prevStart === null ? null : periods().prev);
const events = createMemo((): EventRow[] => eventsOf(cur(), dataset.latest?.events ?? []));
/** Cur + prev sessions after filters: the basis for first-seen computations. */
const scopedAll = () => scoped();

// Same period without the version filter, for version-over-version comparison.
const scopedAnyVersion = createMemo(() =>
  applySessionFilters(rawSessions(), { ...filters(), version: 'all' }),
);
const curAnyVersion = createMemo(() => splitPeriods(scopedAnyVersion(), win()).cur);
const eventsAnyVersion = createMemo((): EventRow[] =>
  eventsOf(curAnyVersion(), dataset.latest?.events ?? []),
);

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
  void refetch();
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
