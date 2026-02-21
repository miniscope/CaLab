import { type JSX, createResource, createMemo } from 'solid-js';
import { DataTable } from './DataTable.tsx';
import {
  fetchSessions,
  fetchEvents,
  computeWeeklySessions,
  computeEventBreakdown,
} from '../lib/analytics-queries.ts';
import { dateRange } from '../lib/admin-store.ts';

export function UsageView(): JSX.Element {
  const [sessions] = createResource(dateRange, fetchSessions);
  const [events] = createResource(dateRange, fetchEvents);

  const weekly = createMemo(() => computeWeeklySessions(sessions() ?? []));
  const eventBreakdown = createMemo(() => computeEventBreakdown(events() ?? []));

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
    </div>
  );
}
