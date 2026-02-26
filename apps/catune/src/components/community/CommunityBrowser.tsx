/**
 * CaTune community browser — thin wrapper around CommunityBrowserShell.
 * Supplies CaTune-specific fetch, filter bar, scatter plot, and user params.
 */

import { createSignal } from 'solid-js';
import { CommunityBrowserShell } from '@calab/ui';
import { fetchSubmissions } from '../../lib/community/index.ts';
import type { CatuneSubmission, CatuneFilterState } from '../../lib/community/index.ts';
import { tauRise, tauDecay, lambda } from '../../lib/viz-store.ts';
import { isDemo, dataSource as appDataSource } from '../../lib/data-store.ts';
import { getPresetLabels } from '@calab/compute';
import { ScatterPlot } from './ScatterPlot.tsx';
import { FilterBar } from './FilterBar.tsx';
import '../../styles/community.css';

export function CommunityBrowser() {
  const [filters, setFilters] = createSignal<CatuneFilterState>({
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
      getUserParams={() => ({
        tauRise: tauRise(),
        tauDecay: tauDecay(),
        lambda: lambda(),
      })}
      compareLabel={{ active: 'Hide my params', inactive: 'Compare my params' }}
      filterBar={(ctx) => (
        <FilterBar
          filters={ctx.filters}
          onFilterChange={ctx.setFilters}
          options={ctx.options}
          filteredCount={ctx.filteredCount}
          totalCount={ctx.totalCount}
          demoPresets={getPresetLabels()}
          showDemoPresetFilter={ctx.dataSource === 'demo'}
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
