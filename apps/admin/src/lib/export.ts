// CSV / JSON export of the filtered data, with column documentation.

import type { EventRow, SessionRow } from './types.ts';
import type { CalaRun } from './cala.ts';
import { sessionDuration } from './metrics.ts';
import { shortHash } from './stats.ts';

function escapeCSV(value: unknown): string {
  const str = String(value ?? '');
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

const FORMULA_TRIGGERS = new Set(['=', '+', '-', '@', '\uFF1D', '\uFF0B', '\uFF0D', '\uFF20']);

/**
 * Neutralise spreadsheet formula injection (OWASP CSV injection). Only strings
 * are touched: a string whose first character is a tab, CR or LF, or whose first
 * non-space character is = + - @ (or a fullwidth variant), gets a leading single
 * quote. Real numbers stay numbers, so -5 is exported as -5.
 */
export function neutralizeCell(v: unknown): unknown {
  if (typeof v !== 'string' || v.length === 0) return v;
  const first = v[0];
  if (first === '\t' || first === '\r' || first === '\n') return `'${v}`;
  const trimmed = v.replace(/^[ \u00A0]+/, '');
  return trimmed.length > 0 && FORMULA_TRIGGERS.has(trimmed[0]) ? `'${v}` : v;
}

/** RFC 4180 CSV with formula neutralisation applied to every string cell. */
export function toCSV(headers: string[], rows: unknown[][]): string {
  const cell = (v: unknown) => escapeCSV(neutralizeCell(v));
  const headerLine = headers.map(cell).join(',');
  const dataLines = rows.map((row) => row.map(cell).join(','));
  return [headerLine, ...dataLines].join('\n');
}

export function downloadText(text: string, filename: string, mime: string): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8;` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export interface ColumnDoc {
  name: string;
  doc: string;
}

export interface ExportTable {
  id: 'sessions' | 'events' | 'runs';
  title: string;
  columns: ColumnDoc[];
  rows: unknown[][];
}

export const SESSION_COLUMNS: ColumnDoc[] = [
  { name: 'session', doc: 'Session id (UUID, one per page load).' },
  { name: 'created_at', doc: 'Session start, ISO 8601 UTC.' },
  { name: 'browser', doc: 'Six-character hash of user_id: one browser profile, not a person.' },
  { name: 'signed_in', doc: 'true for a real account, false for anonymous auth.' },
  { name: 'app', doc: 'App slug (catune, cadecon, cala, ...).' },
  { name: 'version', doc: 'app_version; "dev" for local builds.' },
  { name: 'country', doc: 'ISO country code from the geo-session function.' },
  { name: 'region', doc: 'Region name (may be empty).' },
  { name: 'browser_family', doc: 'user_agent_family.' },
  { name: 'screen', doc: 'Screen width x height in CSS pixels.' },
  { name: 'referrer', doc: 'Referrer domain; empty for direct.' },
  { name: 'duration_s', doc: 'ended_at - created_at in seconds; empty when missing or over 4 h.' },
];

export function sessionTable(sessions: SessionRow[]): ExportTable {
  return {
    id: 'sessions',
    title: 'Sessions',
    columns: SESSION_COLUMNS,
    rows: sessions.map((s) => [
      s.id,
      s.created_at,
      s.user_id ? shortHash(s.user_id) : '',
      s.is_anonymous == null ? '' : s.is_anonymous === false,
      s.app_name,
      s.app_version ?? '',
      s.country_code ?? '',
      s.region ?? '',
      s.user_agent_family ?? '',
      s.screen_width && s.screen_height ? `${s.screen_width}x${s.screen_height}` : '',
      s.referrer_domain ?? '',
      sessionDuration(s) ?? '',
    ]),
  };
}

export const EVENT_COLUMNS: ColumnDoc[] = [
  { name: 'created_at', doc: 'Event time, ISO 8601 UTC.' },
  { name: 'session', doc: 'Session id; join to the sessions export.' },
  { name: 'app', doc: 'App of the session ("" if the session is outside the loaded window).' },
  { name: 'event', doc: 'Event name (see docs/analytics.md).' },
  { name: 'data', doc: 'event_data as JSON text.' },
];

export function eventTable(events: EventRow[], sessions: SessionRow[]): ExportTable {
  const app = new Map(sessions.map((s) => [s.id, s.app_name]));
  return {
    id: 'events',
    title: 'Events',
    columns: EVENT_COLUMNS,
    rows: events.map((e) => [
      e.created_at,
      e.session_id,
      app.get(e.session_id) ?? '',
      e.event_name,
      JSON.stringify(e.event_data ?? {}),
    ]),
  };
}

export const RUN_COLUMNS: ColumnDoc[] = [
  { name: 'finished_at', doc: 'run_finished time, ISO 8601 UTC.' },
  { name: 'session', doc: 'Session id.' },
  { name: 'version', doc: 'Cala version.' },
  { name: 'stage', doc: 'discover, refine or extract.' },
  { name: 'mode', doc: 'joint, separate, apply or single.' },
  { name: 'recordings', doc: 'Recordings (sessions) in the run.' },
  { name: 'frames', doc: 'Frames processed.' },
  { name: 'fps_recorded', doc: 'Recording frame rate.' },
  { name: 'megapixels', doc: 'width x height / 1e6.' },
  { name: 'duration_s', doc: 'Wall-clock run time in seconds.' },
  { name: 'median_fps', doc: 'Median processing frames per second.' },
  { name: 'cells', doc: 'Cells found.' },
  { name: 'peak_wasm_mb', doc: 'Peak main-thread WASM heap (not whole tab); often empty.' },
  { name: 'adapter', doc: 'WebGPU adapter class: hardware, fallback (software), none, unknown.' },
  { name: 'vendor', doc: 'WebGPU vendor string.' },
  { name: 'browser_family', doc: 'user_agent_family.' },
];

export function runTable(runs: CalaRun[]): ExportTable {
  return {
    id: 'runs',
    title: 'Cala runs',
    columns: RUN_COLUMNS,
    rows: runs.map((r) => [
      new Date(r.at).toISOString(),
      r.sessionId,
      r.version,
      r.stage,
      r.mode,
      r.sessions ?? '',
      r.frames ?? '',
      r.fps ?? '',
      r.megapixels === null ? '' : +r.megapixels.toFixed(3),
      r.durationS ?? '',
      r.medianFps ?? '',
      r.cells ?? '',
      r.peakWasmMb ?? '',
      r.adapter,
      r.vendor ?? '',
      r.userAgent,
    ]),
  };
}

export function tableToCSV(t: ExportTable): string {
  return toCSV(
    t.columns.map((c) => c.name),
    t.rows,
  );
}

export function tableToJSON(t: ExportTable): string {
  const names = t.columns.map((c) => c.name);
  return JSON.stringify(
    t.rows.map((r) => Object.fromEntries(names.map((n, i) => [n, r[i]]))),
    null,
    2,
  );
}

export function columnDocsCSV(t: ExportTable): string {
  return toCSV(
    ['column', 'description'],
    t.columns.map((c) => [c.name, c.doc]),
  );
}

export function catuneSubmissionTable(rows: import('./types.ts').SubmissionRow[]): ExportTable {
  const cols = [
    'created_at',
    'indicator',
    'species',
    'brain_region',
    'data_source',
    'tau_rise',
    'tau_decay',
    'lambda',
    'sampling_rate',
    'app_version',
  ] as const;
  return {
    id: 'sessions',
    title: 'CaTune submissions',
    columns: cols.map((name) => ({ name, doc: name.replace(/_/g, ' ') })),
    rows: rows.map((r) => cols.map((c) => r[c] ?? '')),
  };
}

export function cadeconSubmissionTable(
  rows: import('./types.ts').CadeconSubmissionRow[],
): ExportTable {
  const cols = [
    'created_at',
    'indicator',
    'species',
    'brain_region',
    'data_source',
    'tau_rise',
    'tau_decay',
    'sampling_rate',
    'median_alpha',
    'median_pve',
    'mean_event_rate',
    'num_iterations',
    'converged',
    'app_version',
  ] as const;
  return {
    id: 'sessions',
    title: 'CaDecon submissions',
    columns: cols.map((name) => ({ name, doc: name.replace(/_/g, ' ') })),
    rows: rows.map((r) => cols.map((c) => r[c] ?? '')),
  };
}
