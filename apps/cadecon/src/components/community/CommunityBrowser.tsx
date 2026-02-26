/**
 * CaDecon community browser — scatter plot, filter bar, data source toggle.
 * Fetches community data from Supabase, applies filters,
 * and optionally overlays the user's current kernel parameters.
 *
 * Guards on supabaseEnabled — does not render when Supabase is not configured.
 */

import { createSignal, createEffect, createMemo, Show, on } from 'solid-js';
import { FilterBar } from '@calab/ui';
import {
  supabaseEnabled,
  fetchSubmissions,
  fieldOptions,
  loadFieldOptions,
  user,
} from '../../lib/community/index.ts';
import type {
  CadeconSubmission,
  CadeconFilterState,
  DataSource,
} from '../../lib/community/index.ts';
import { currentTauRise, currentTauDecay } from '../../lib/iteration-store.ts';
import { isDemo, dataSource as appDataSource } from '../../lib/data-store.ts';
import { ScatterPlot } from './ScatterPlot.tsx';
import '../../styles/community.css';

const STALE_THRESHOLD_MS = 5 * 60 * 1000;

export function CommunityBrowser() {
  const [submissions, setSubmissions] = createSignal<CadeconSubmission[]>([]);
  const [filters, setFilters] = createSignal<CadeconFilterState>({
    indicator: null,
    species: null,
    brainRegion: null,
    demoPreset: null,
  });
  const [dataSource, setDataSource] = createSignal<DataSource>(isDemo() ? 'demo' : 'user');
  const [loading, setLoading] = createSignal(false);
  const [collapsed, setCollapsed] = createSignal(false);
  const [compareMyParams, setCompareMyParams] = createSignal(false);
  const [highlightMine, setHighlightMine] = createSignal(false);
  const [lastFetched, setLastFetched] = createSignal<number | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  createEffect(
    on(appDataSource, (src) => {
      setDataSource(src === 'demo' ? 'demo' : 'user');
    }),
  );

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

  const sourceSubmissions = createMemo(() => {
    const ds = dataSource();
    return submissions().filter((s) => s.data_source === ds);
  });

  const userParams = createMemo(() => {
    if (!compareMyParams()) return null;
    const tr = currentTauRise();
    const td = currentTauDecay();
    if (tr == null || td == null) return null;
    return { tauRise: tr, tauDecay: td };
  });

  const highlightFlags = createMemo((): boolean[] | null => {
    if (!highlightMine()) return null;
    const uid = user()?.id;
    if (!uid) return null;
    return filteredSubmissions().map((s) => s.user_id === uid);
  });

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

  function isStale(): boolean {
    const last = lastFetched();
    if (last === null) return true;
    return Date.now() - last > STALE_THRESHOLD_MS;
  }

  createEffect(() => {
    if (!collapsed() && isStale()) {
      loadData();
    }
  });

  if (!supabaseEnabled) return null;

  return (
    <div class="community-browser" data-tutorial="community-browser">
      <div class="community-browser__header" onClick={() => setCollapsed((p) => !p)}>
        <h3 class="community-browser__title">Community Parameters</h3>
        <span
          class={`community-browser__chevron ${collapsed() ? '' : 'community-browser__chevron--expanded'}`}
        >
          &#9660;
        </span>
      </div>

      <Show when={!collapsed()}>
        <div class="community-browser__body">
          <Show when={loading()}>
            <div class="community-browser__loading">Loading community data...</div>
          </Show>

          <Show when={error() && !loading()}>
            <div class="community-browser__empty">{error()}</div>
          </Show>

          <Show when={!loading() && !error()}>
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

            <FilterBar
              filters={filters()}
              onFilterChange={setFilters}
              options={fieldOptions()}
              filteredCount={filteredSubmissions().length}
              totalCount={sourceSubmissions().length}
              highlightMine={highlightMine()}
              onHighlightMineChange={() => setHighlightMine((p) => !p)}
              canHighlight={!!user()}
            />

            <div class="community-browser__controls">
              <button
                class={`community-browser__compare-btn ${
                  compareMyParams() ? 'community-browser__compare-btn--active' : ''
                }`}
                onClick={() => setCompareMyParams((p) => !p)}
              >
                {compareMyParams() ? 'Hide my run' : 'Compare my run'}
              </button>
            </div>

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
              <ScatterPlot
                submissions={filteredSubmissions()}
                userParams={userParams()}
                highlightFlags={highlightFlags()}
              />
            </Show>
          </Show>
        </div>
      </Show>
    </div>
  );
}
