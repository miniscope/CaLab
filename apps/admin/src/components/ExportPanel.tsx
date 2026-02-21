import { type JSX, createResource } from 'solid-js';
import { toCSV, downloadCSV } from '../lib/csv-export.ts';
import {
  fetchSessions,
  fetchEvents,
  fetchSubmissions,
  computeGeoBreakdown,
  computeEventBreakdown,
  computeWeeklySessions,
} from '../lib/analytics-queries.ts';
import { dateRange } from '../lib/admin-store.ts';

export function ExportPanel(): JSX.Element {
  const [sessions] = createResource(dateRange, fetchSessions);
  const [events] = createResource(dateRange, fetchEvents);
  const [submissions] = createResource(fetchSubmissions);

  const range = () => dateRange();
  const filenameSuffix = () => `${range().start}_to_${range().end}`;

  const exportSessions = () => {
    const weekly = computeWeeklySessions(sessions() ?? []);
    const csv = toCSV(
      ['Week Starting', 'Sessions'],
      weekly.map((w) => [w.week, w.count]),
    );
    downloadCSV(csv, `calab-sessions-${filenameSuffix()}.csv`);
  };

  const exportEvents = () => {
    const breakdown = computeEventBreakdown(events() ?? []);
    const csv = toCSV(
      ['Event Name', 'Count'],
      breakdown.map((e) => [e.event_name, e.count]),
    );
    downloadCSV(csv, `calab-events-${filenameSuffix()}.csv`);
  };

  const exportGeography = () => {
    const geo = computeGeoBreakdown(sessions() ?? []);
    const csv = toCSV(
      ['Country', 'Region', 'Sessions'],
      geo.map((g) => [g.country_code, g.region ?? '', g.count]),
    );
    downloadCSV(csv, `calab-geography-${filenameSuffix()}.csv`);
  };

  const exportSubmissions = () => {
    const subs = submissions() ?? [];
    const csv = toCSV(
      ['Date', 'Indicator', 'Species', 'Brain Region', 'Source', 'Version'],
      subs.map((s) => [
        s.created_at,
        s.indicator,
        s.species,
        s.brain_region,
        s.data_source,
        s.app_version ?? '',
      ]),
    );
    downloadCSV(csv, `calab-submissions-${filenameSuffix()}.csv`);
  };

  return (
    <div class="view">
      <h2 class="view__title">Export CSV</h2>
      <p class="view__desc">
        Download data as CSV for the selected date range. Open in any spreadsheet application for
        grant progress reports.
      </p>
      <div class="export-grid">
        <button class="export-btn" onClick={exportSessions}>
          Sessions Summary
        </button>
        <button class="export-btn" onClick={exportEvents}>
          Event Breakdown
        </button>
        <button class="export-btn" onClick={exportGeography}>
          Geographic Breakdown
        </button>
        <button class="export-btn" onClick={exportSubmissions}>
          Submissions List
        </button>
      </div>
    </div>
  );
}
