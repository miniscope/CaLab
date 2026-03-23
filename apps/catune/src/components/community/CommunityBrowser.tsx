/**
 * CaTune community browser — thin wrapper around CommunityBrowserShell.
 * Supplies CaTune-specific fetch, filter bar, scatter plot, and user params.
 */

import { createSignal } from 'solid-js';
import { CommunityBrowserShell, FilterBar } from '@calab/ui';
import { fetchSubmissions } from '../../lib/community/index.ts';
import type { CatuneSubmission, CatuneFilterState } from '../../lib/community/index.ts';
import { tPeak, fwhm, lambda } from '../../lib/viz-store.ts';
import { isDemo, dataSource as appDataSource } from '../../lib/data-store.ts';
import { getSimulationPresetLabels } from '@calab/compute';
import { ScatterPlot } from './ScatterPlot.tsx';
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
        tPeak: tPeak(),
        fwhm: fwhm(),
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
          extraFilters={[
            {
              id: 'demoPreset',
              label: 'All presets',
              options: getSimulationPresetLabels(),
            },
          ]}
          showExtraFiltersOnly={ctx.dataSource === 'demo'}
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
