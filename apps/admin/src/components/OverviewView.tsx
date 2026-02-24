import { type JSX, createMemo, createResource } from 'solid-js';
import { MetricCard } from './MetricCard.tsx';
import { DataTable } from './DataTable.tsx';
import {
  fetchSessions,
  fetchSubmissions,
  computeMetrics,
  computeSourceBreakdown,
} from '../lib/analytics-queries.ts';
import { dateRange } from '../lib/admin-store.ts';

export function OverviewView(): JSX.Element {
  const [sessions] = createResource(dateRange, fetchSessions);
  const [submissions] = createResource(dateRange, fetchSubmissions);

  const metrics = createMemo(() => computeMetrics(sessions() ?? [], submissions() ?? []));
  const sourceBreakdown = createMemo(() => computeSourceBreakdown(submissions() ?? []));

  return (
    <div class="view">
      <h2 class="view__title">Overview</h2>
      <div class="metric-grid">
        <MetricCard label="Total Sessions" value={metrics().totalSessions} />
        <MetricCard label="Unique Users" value={metrics().uniqueUsers} />
        <MetricCard label="Anonymous Sessions" value={metrics().anonymousSessions} />
        <MetricCard label="Community Submissions" value={metrics().totalSubmissions} />
        <MetricCard label="Avg Session Duration" value={metrics().avgDurationMinutes} />
        <MetricCard label="Top Referrer" value={metrics().topReferrer} />
      </div>

      <h2 class="view__title">Submissions by Source</h2>
      <DataTable
        columns={[
          { key: 'data_source', label: 'Source' },
          { key: 'count', label: 'Count', bar: true },
        ]}
        rows={sourceBreakdown()}
      />
    </div>
  );
}
