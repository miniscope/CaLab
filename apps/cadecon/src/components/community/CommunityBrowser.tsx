/**
 * CaDecon community browser — thin wrapper around CommunityBrowserShell.
 * Supplies CaDecon-specific fetch, filter bar, scatter plot, and user params.
 */

import { createSignal } from 'solid-js';
import { CommunityBrowserShell, FilterBar } from '@calab/ui';
import { fetchSubmissions } from '../../lib/community/index.ts';
import type { CadeconSubmission, CadeconFilterState } from '../../lib/community/index.ts';
import { currentTauRise, currentTauDecay } from '../../lib/iteration-store.ts';
import { isDemo, dataSource as appDataSource } from '../../lib/data-store.ts';
import { ScatterPlot } from './ScatterPlot.tsx';
import '../../styles/community.css';

export function CommunityBrowser() {
  const [filters, setFilters] = createSignal<CadeconFilterState>({
    indicator: null,
    species: null,
    brainRegion: null,
    demoPreset: null,
  });

  return (
    <CommunityBrowserShell
      fetchSubmissions={fetchSubmissions}
      filters={filters}
      setFilters={setFilters}
      isDemo={isDemo}
      appDataSource={appDataSource}
      getUserParams={() => {
        const tr = currentTauRise();
        const td = currentTauDecay();
        if (tr == null || td == null) return null;
        return { tauRise: tr, tauDecay: td };
      }}
      compareLabel={{ active: 'Hide my run', inactive: 'Compare my run' }}
      filterBar={(ctx) => (
        <FilterBar
          filters={ctx.filters}
          onFilterChange={ctx.setFilters}
          options={ctx.options}
          filteredCount={ctx.filteredCount}
          totalCount={ctx.totalCount}
          highlightMine={ctx.highlightMine}
          onHighlightMineChange={ctx.toggleHighlightMine}
          canHighlight={ctx.canHighlight}
        />
      )}
      renderChart={(ctx) => (
        <ScatterPlot
          submissions={ctx.data}
          userParams={ctx.userParams}
          highlightFlags={ctx.highlightFlags}
        />
      )}
    />
  );
}
