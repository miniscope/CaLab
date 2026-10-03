/**
 * CaDecon community browser — thin wrapper around CommunityBrowserShell.
 * Supplies CaDecon-specific fetch, scatter plot, and user params.
 */

import { createSignal } from 'solid-js';
import { CommunityBrowserShell, CommunityScatterPlot, scatterRampColor } from '@calab/community-ui';
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
