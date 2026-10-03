/**
 * CaDecon community browser — thin wrapper around CommunityBrowserShell.
 * Supplies CaDecon-specific fetch, filter bar, scatter plot, and user params.
 */

import { createSignal } from 'solid-js';
import {
  CommunityBrowserShell,
  CommunityScatterPlot,
  FilterBar,
  DEMO_PRESET_FILTER,
  scatterRampColor,
} from '@calab/community-ui';
import { fetchSubmissions } from '../../lib/community/index.ts';
import type { CadeconFilterState } from '../../lib/community/index.ts';
import { currentTauRise, currentTauDecay } from '../../lib/iteration-store.ts';
import { isDemo, dataSource as appDataSource } from '../../lib/data-store.ts';
import { tauToShape } from '@calab/compute';
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
        const shape = tauToShape(tr, td);
        if (!shape) return null;
        return { tPeak: shape.tPeak, fwhm: shape.fwhm };
      }}
      compareLabel={{ active: 'Hide my run', inactive: 'Compare my run' }}
      filterBar={(ctx) => (
        <FilterBar
          filters={ctx.filters}
          onFilterChange={ctx.setFilters}
          options={ctx.options}
          filteredCount={ctx.filteredCount}
          totalCount={ctx.totalCount}
          extraFilters={[DEMO_PRESET_FILTER]}
          showExtraFiltersOnly={ctx.dataSource === 'demo'}
          highlightMine={ctx.highlightMine}
          onHighlightMineChange={ctx.toggleHighlightMine}
          canHighlight={ctx.canHighlight}
        />
      )}
      renderChart={(ctx) => (
        <CommunityScatterPlot
          submissions={ctx.data}
          pointColor={(s) =>
            s.median_pve == null ? 'hsla(200, 10%, 60%, 0.5)' : scatterRampColor(s.median_pve)
          }
          userParams={ctx.userParams}
          userColor="hsla(30, 100%, 55%, 0.9)"
          highlightFlags={ctx.highlightFlags}
          legend={{
            minLabel: '0',
            maxLabel: '1',
            title: 'median PVE',
            colorAt: (t) => scatterRampColor(t, 0.9),
          }}
        />
      )}
    />
  );
}
