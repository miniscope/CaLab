import { type JSX, createResource, createMemo } from 'solid-js';
import { DataTable } from './DataTable.tsx';
import { fetchSessions, computeGeoBreakdown } from '../lib/analytics-queries.ts';
import { dateRange } from '../lib/admin-store.ts';

export function GeographyView(): JSX.Element {
  const [sessions] = createResource(dateRange, fetchSessions);
  const geo = createMemo(() => computeGeoBreakdown(sessions() ?? []));

  return (
    <div class="view">
      <h2 class="view__title">Geographic Distribution</h2>
      <DataTable
        columns={[
          { key: 'country_code', label: 'Country' },
          { key: 'region', label: 'Region' },
          { key: 'count', label: 'Sessions', bar: true },
        ]}
        rows={geo()}
      />
    </div>
  );
}
