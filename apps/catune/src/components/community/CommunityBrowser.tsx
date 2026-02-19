/**
 * Collapsible community browser composing scatter plot, marginal histograms,
 * and filter bar. Fetches community data from Supabase, applies filters,
 * and optionally overlays the user's current parameters.
 *
 * Guards on supabaseEnabled -- does not render when Supabase is not configured.
 * Built as a modular, self-contained component per locked decision.
 */

import { createSignal, createEffect, createMemo, Show, on } from 'solid-js';
import {
  supabaseEnabled,
  fetchSubmissions,
  fieldOptions,
  loadFieldOptions,
} from '../../lib/community/index.ts';
import type { CommunitySubmission, DataSource, FilterState } from '../../lib/community/index.ts';
import { tauRise, tauDecay, lambda } from '../../lib/viz-store.ts';
import { isDemo } from '../../lib/data-store.ts';
import { getPresetLabels } from '@calab/compute';
import { ScatterPlot } from './ScatterPlot.tsx';
import { FilterBar } from './FilterBar.tsx';
import '../../styles/community.css';

/** Stale-while-revalidate threshold: 5 minutes in milliseconds. */
const STALE_THRESHOLD_MS = 5 * 60 * 1000;

export function CommunityBrowser() {
  // --- State signals ---
  const [submissions, setSubmissions] = createSignal<CommunitySubmission[]>([]);
  const [filters, setFilters] = createSignal<FilterState>({
    indicator: null,
    species: null,
    brainRegion: null,
    demoPreset: null,
  });
  const [dataSource, setDataSource] = createSignal<DataSource>(isDemo() ? 'demo' : 'user');
  const [loading, setLoading] = createSignal(false);
  const [collapsed, setCollapsed] = createSignal(false);
  const [compareMyParams, setCompareMyParams] = createSignal(false);
  const [lastFetched, setLastFetched] = createSignal<number | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  // Auto-switch data source when demo mode changes
  createEffect(
    on(isDemo, (demo) => {
      setDataSource(demo ? 'demo' : 'user');
    }),
  );

  // --- Filtered data ---
  const filteredSubmissions = createMemo(() => {
    const subs = submissions();
    const f = filters();
    const ds = dataSource();
    return subs.filter((s) => {
      if (s.data_source !== ds) return false;
      if (f.indicator && s.indicator !== f.indicator) return false;
      if (f.species && s.species !== f.species) return false;
      if (f.brainRegion && s.brain_region !== f.brainRegion) return false;
      if (f.demoPreset && s.data_source === 'demo') {
        const preset = (s.extra_metadata as Record<string, unknown> | undefined)?.demo_preset;
        if (preset !== f.demoPreset) return false;
      }
      return true;
    });
  });

  /** Submissions matching the current data source (before dropdown filters). */
  const sourceSubmissions = createMemo(() => {
    const ds = dataSource();
    return submissions().filter((s) => s.data_source === ds);
  });

  /** Extract parameter arrays from filtered submissions. */
  const tauRiseValues = createMemo(() => filteredSubmissions().map((s) => s.tau_rise));
  const tauDecayValues = createMemo(() => filteredSubmissions().map((s) => s.tau_decay));

  /** User params for "Compare my params" overlay. */
  const userParams = createMemo(() =>
    compareMyParams() ? { tauRise: tauRise(), tauDecay: tauDecay(), lambda: lambda() } : null,
  );

  // --- Data fetching ---
  async function loadData(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const [subs] = await Promise.all([fetchSubmissions(), loadFieldOptions()]);
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

  // Re-fetch when filters change (server-side filtering)
  // Client-side filtering is used instead per current implementation;
  // no re-fetch needed since we filter the full local dataset.

  function toggleCollapse(): void {
    setCollapsed((prev) => !prev);
  }

  function toggleCompare(): void {
    setCompareMyParams((prev) => !prev);
  }

  // Guard: do not render if Supabase is not configured
  if (!supabaseEnabled) return null;

  return (
    <div class="community-browser" data-tutorial="community-browser">
      {/* Collapsible header */}
      <div class="community-browser__header" onClick={toggleCollapse}>
        <h3 class="community-browser__title">Community Parameters</h3>
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
              <Show when={isDemo() && dataSource() === 'demo'}>
                <span class="community-browser__source-hint">
                  Viewing demo parameters — submitting your demo results is encouraged!
                </span>
              </Show>
            </div>

            {/* Filter bar */}
            <FilterBar
              filters={filters()}
              onFilterChange={setFilters}
              options={fieldOptions()}
              filteredCount={filteredSubmissions().length}
              totalCount={sourceSubmissions().length}
              demoPresets={getPresetLabels()}
              showDemoPresetFilter={dataSource() === 'demo'}
            />

            {/* Controls: Compare toggle */}
            <div class="community-browser__controls">
              <button
                class={`community-browser__compare-btn ${
                  compareMyParams() ? 'community-browser__compare-btn--active' : ''
                }`}
                onClick={toggleCompare}
              >
                {compareMyParams() ? 'Hide my params' : 'Compare my params'}
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
              <ScatterPlot submissions={filteredSubmissions()} userParams={userParams()} />
            </Show>
          </Show>
        </div>
      </Show>
    </div>
  );
}
