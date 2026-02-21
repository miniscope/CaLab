import { type JSX, createResource } from 'solid-js';
import { MetricCard } from './MetricCard.tsx';
import { fetchSessions, fetchSubmissions, computeMetrics } from '../lib/analytics-queries.ts';
import { dateRange } from '../lib/admin-store.ts';

export function OverviewView(): JSX.Element {
  const [sessions] = createResource(dateRange, fetchSessions);
  const [submissions] = createResource(fetchSubmissions);

  const metrics = () => computeMetrics(sessions() ?? [], submissions() ?? []);

  return (
    <div class="view">
      <h2 class="view__title">Overview</h2>
      <div class="metric-grid">
        <MetricCard label="Total Sessions" value={metrics().totalSessions} />
        <MetricCard label="Unique Users" value={metrics().uniqueUsers} />
        <MetricCard label="Anonymous Sessions" value={metrics().anonymousSessions} />
        <MetricCard label="Community Submissions" value={metrics().totalSubmissions} />
      </div>
    </div>
  );
}
