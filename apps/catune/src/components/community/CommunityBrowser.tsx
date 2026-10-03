/**
 * CaTune community browser — thin wrapper around CommunityBrowserShell.
 * Supplies CaTune-specific fetch, scatter plot, and user params.
 */

import { createSignal } from 'solid-js';
import { CommunityBrowserShell, CommunityScatterPlot, scatterRampColor } from '@calab/community-ui';
import { fetchSubmissions } from '../../lib/community/index.ts';
import type { CatuneFilterState } from '../../lib/community/index.ts';
import { tPeak, fwhm, lambda } from '../../lib/viz-store.ts';
import { isDemo, dataSource as appDataSource } from '../../lib/data-store.ts';
import '../../styles/community.css';

/** Fixed lambda colour range, so colours mean the same thing across filters. */
const LAMBDA_RANGE_MIN = 0;
const LAMBDA_RANGE_MAX = 10;

const lambdaColor = (lambda: number, alpha?: number): string =>
  scatterRampColor((lambda - LAMBDA_RANGE_MIN) / (LAMBDA_RANGE_MAX - LAMBDA_RANGE_MIN), alpha);

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
      renderChart={(ctx) => (
        <CommunityScatterPlot
          submissions={ctx.data}
          pointColor={(s) => lambdaColor(s.lambda)}
          userParams={ctx.userParams}
          userColor={ctx.userParams ? lambdaColor(ctx.userParams.lambda) : undefined}
          highlightFlags={ctx.highlightFlags}
          legend={{
            minLabel: String(LAMBDA_RANGE_MIN),
            maxLabel: String(LAMBDA_RANGE_MAX),
            title: 'λ',
            colorAt: (t) => scatterRampColor(t, 0.9),
          }}
        />
      )}
    />
  );
}
