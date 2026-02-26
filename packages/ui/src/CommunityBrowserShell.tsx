/**
 * Shared community browser shell for CaLab apps.
 *
 * Encapsulates the collapsible header, stale-while-revalidate fetch logic,
 * data source toggle, loading/error/empty states, FilterBar integration,
 * "Compare My Params" toggle, and highlightFlags computation.
 *
 * Apps provide a thin wrapper that supplies:
 *   - fetch / loadFieldOptions functions
 *   - filter bar JSX (via `filterBar` prop)
 *   - chart render prop
 *   - user params accessor
 *
 * Guards on supabaseEnabled — does not render when Supabase is not configured.
 */

import { createSignal, createEffect, createMemo, Show, on } from 'solid-js';
import type { JSX, Accessor } from 'solid-js';
import type { BaseSubmission, BaseFilterState, DataSource } from '@calab/community';
import { supabaseEnabled, user, fieldOptions, loadFieldOptions } from '@calab/community';
import './styles/community.css';

/** Stale-while-revalidate threshold: 5 minutes in milliseconds. */
const STALE_THRESHOLD_MS = 5 * 60 * 1000;

export interface CommunityBrowserShellProps<
  T extends BaseSubmission,
  F extends BaseFilterState,
  P = Record<string, unknown>,
> {
  /** Fetch all submissions for this app's table. */
  fetchSubmissions: () => Promise<T[]>;

  /** Reactive accessor for the current filter state. */
  filters: Accessor<F>;

  /** Setter for the filter state. */
  setFilters: (f: F) => void;

  /** App-specific filter bar JSX. Receives fieldOptions, filteredCount,
   *  totalCount, highlightMine state, and its toggle so apps can wire
   *  their own FilterBar variant. */
  filterBar: (ctx: {
    filters: F;
    setFilters: (f: F) => void;
    options: ReturnType<typeof fieldOptions>;
    filteredCount: number;
    totalCount: number;
    highlightMine: boolean;
    toggleHighlightMine: () => void;
    canHighlight: boolean;
    dataSource: DataSource;
  }) => JSX.Element;

  /** Render prop for the scatter/chart area. */
  renderChart: (ctx: {
    data: T[];
    highlightFlags: boolean[] | null;
    userParams: P | null;
  }) => JSX.Element;

  /** Returns the user's current params object, or null if unavailable.
   *  The shell gates this behind the compare toggle signal. */
  getUserParams: () => P | null;

  /** Reactive accessor: is the app currently showing demo data? */
  isDemo: Accessor<boolean>;

  /** Reactive accessor: app-level data source (e.g. from data-store). */
  appDataSource: Accessor<DataSource | string | null>;

  /** Title shown in the collapsible header. */
  title?: string;

  /** Label for the compare button in its active/inactive states. */
  compareLabel?: { active: string; inactive: string };
}

export function CommunityBrowserShell<
  T extends BaseSubmission,
  F extends BaseFilterState,
  P = Record<string, unknown>,
>(props: CommunityBrowserShellProps<T, F, P>) {
  // --- State signals ---
  const [submissions, setSubmissions] = createSignal<T[]>([]);
  const [dataSource, setDataSource] = createSignal<DataSource>(props.isDemo() ? 'demo' : 'user');
  const [loading, setLoading] = createSignal(false);
  const [collapsed, setCollapsed] = createSignal(false);
  const [compareMyParams, setCompareMyParams] = createSignal(false);
  const [highlightMine, setHighlightMine] = createSignal(false);
  const [lastFetched, setLastFetched] = createSignal<number | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  // Auto-switch data source filter when app data source changes
  createEffect(
    on(
      () => props.appDataSource(),
      (src) => {
        setDataSource(src === 'demo' ? 'demo' : 'user');
      },
    ),
  );

  // --- Filtered data ---
  const filteredSubmissions = createMemo(() => {
    const subs = submissions();
    const f = props.filters();
    const ds = dataSource();
    return subs.filter((s) => {
      if (s.data_source !== ds) return false;
      if (f.indicator && s.indicator !== f.indicator) return false;
      if (f.species && s.species !== f.species) return false;
      if (f.brainRegion && s.brain_region !== f.brainRegion) return false;
      // Generic demoPreset filter — works for any F that has it
      const fAny = f as Record<string, unknown>;
      if (fAny.demoPreset && s.data_source === 'demo') {
        const preset = (s.extra_metadata as Record<string, unknown> | undefined)?.demo_preset;
        if (preset !== fAny.demoPreset) return false;
      }
      return true;
    });
  });

  /** Submissions matching the current data source (before dropdown filters). */
  const sourceSubmissions = createMemo(() => {
    const ds = dataSource();
    return submissions().filter((s) => s.data_source === ds);
  });

  /** User params for "Compare my params" overlay. */
  const userParams = createMemo((): P | null => (compareMyParams() ? props.getUserParams() : null));

  /** Per-point flags: true for the current user's submissions when highlight is active. */
  const highlightFlags = createMemo((): boolean[] | null => {
    if (!highlightMine()) return null;
    const uid = user()?.id;
    if (!uid) return null;
    return filteredSubmissions().map((s) => s.user_id === uid);
  });

  // --- Data fetching ---
  async function loadData(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const [subs] = await Promise.all([props.fetchSubmissions(), loadFieldOptions()]);
      setSubmissions(subs);
      setLastFetched(Date.now());
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load community data';
      setError(msg);
      console.error('CommunityBrowser load error:', err);
    } finally {
      setLoading(false);
    }
  }

  /** Check if data is stale and needs refetching. */
  function isStale(): boolean {
    const last = lastFetched();
    if (last === null) return true;
    return Date.now() - last > STALE_THRESHOLD_MS;
  }

  // Fetch data when expanded (and stale or first time)
  createEffect(() => {
    if (!collapsed() && isStale()) {
      loadData();
    }
  });

  const title = () => props.title ?? 'Community Parameters';
  const compareLabels = () =>
    props.compareLabel ?? { active: 'Hide my params', inactive: 'Compare my params' };

  // Guard: do not render if Supabase is not configured
  if (!supabaseEnabled) return null;

  return (
    <div class="community-browser" data-tutorial="community-browser">
      {/* Collapsible header */}
      <div class="community-browser__header" onClick={() => setCollapsed((p) => !p)}>
        <h3 class="community-browser__title">{title()}</h3>
        <span
          class={`community-browser__chevron ${collapsed() ? '' : 'community-browser__chevron--expanded'}`}
        >
          &#9660;
        </span>
      </div>

      {/* Expanded body */}
      <Show when={!collapsed()}>
        <div class="community-browser__body">
          {/* Loading state */}
          <Show when={loading()}>
            <div class="community-browser__loading">Loading community data...</div>
          </Show>

          {/* Error state */}
          <Show when={error() && !loading()}>
            <div class="community-browser__empty">{error()}</div>
          </Show>

          {/* Content when loaded */}
          <Show when={!loading() && !error()}>
            {/* Data source toggle */}
            <div class="community-browser__source-row">
              <div class="community-browser__source-toggle">
                <button
                  class={`community-browser__source-btn ${dataSource() === 'user' ? 'community-browser__source-btn--active' : ''}`}
                  onClick={() => setDataSource('user')}
                >
                  User data
                </button>
                <button
                  class={`community-browser__source-btn ${dataSource() === 'demo' ? 'community-browser__source-btn--active' : ''}`}
                  onClick={() => setDataSource('demo')}
                >
                  Demo data
                </button>
              </div>
              <Show when={props.isDemo() && dataSource() === 'demo'}>
                <span class="community-browser__source-hint">
                  Viewing demo parameters — submitting your demo results is encouraged!
                </span>
              </Show>
            </div>

            {/* Filter bar (app-specific) */}
            {props.filterBar({
              filters: props.filters(),
              setFilters: props.setFilters,
              options: fieldOptions(),
              filteredCount: filteredSubmissions().length,
              totalCount: sourceSubmissions().length,
              highlightMine: highlightMine(),
              toggleHighlightMine: () => setHighlightMine((p) => !p),
              canHighlight: !!user(),
              dataSource: dataSource(),
            })}

            {/* Controls: Compare toggle */}
            <div class="community-browser__controls">
              <button
                class={`community-browser__compare-btn ${
                  compareMyParams() ? 'community-browser__compare-btn--active' : ''
                }`}
                onClick={() => setCompareMyParams((p) => !p)}
              >
                {compareMyParams() ? compareLabels().active : compareLabels().inactive}
              </button>
            </div>

            {/* Empty state */}
            <Show
              when={filteredSubmissions().length > 0}
              fallback={
                <div class="community-browser__empty">
                  {submissions().length === 0
                    ? 'No community data yet -- be the first to share!'
                    : 'No submissions match your filters'}
                </div>
              }
            >
              {props.renderChart({
                data: filteredSubmissions(),
                highlightFlags: highlightFlags(),
                userParams: userParams(),
              })}
            </Show>
          </Show>
        </div>
      </Show>
    </div>
  );
}
