import { type JSX, createResource, createMemo } from 'solid-js';
import { DataTable } from './DataTable.tsx';
import {
  fetchSessions,
  fetchEvents,
  computeWeeklySessions,
  computeEventBreakdown,
  computeAppBreakdown,
  computeReferrerBreakdown,
} from '../lib/analytics-queries.ts';
import { dateRange } from '../lib/admin-store.ts';

export function UsageView(): JSX.Element {
  const [sessions] = createResource(dateRange, fetchSessions);
  const [events] = createResource(dateRange, fetchEvents);

  const weekly = createMemo(() => computeWeeklySessions(sessions() ?? []));
  const eventBreakdown = createMemo(() => computeEventBreakdown(events() ?? []));
  const appBreakdown = createMemo(() => computeAppBreakdown(sessions() ?? []));
  const referrerBreakdown = createMemo(() => computeReferrerBreakdown(sessions() ?? []));

  return (
    <div class="view">
      <h2 class="view__title">Sessions by Week</h2>
      <DataTable
        columns={[
          { key: 'week', label: 'Week Starting' },
          { key: 'count', label: 'Sessions', bar: true },
        ]}
        rows={weekly()}
      />

      <h2 class="view__title">Event Breakdown</h2>
      <DataTable
        columns={[
          { key: 'event_name', label: 'Event' },
          { key: 'count', label: 'Count', bar: true },
        ]}
        rows={eventBreakdown()}
      />

      <h2 class="view__title">Sessions by App</h2>
      <DataTable
        columns={[
          { key: 'app_name', label: 'App' },
          { key: 'count', label: 'Sessions', bar: true },
        ]}
        rows={appBreakdown()}
      />

      <h2 class="view__title">Referrer Domains</h2>
      <DataTable
        columns={[
          { key: 'referrer_domain', label: 'Referrer' },
          { key: 'count', label: 'Sessions', bar: true },
        ]}
        rows={referrerBreakdown()}
      />
    </div>
  );
}
