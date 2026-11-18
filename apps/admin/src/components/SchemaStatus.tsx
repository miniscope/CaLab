import { type JSX, createResource, For, Show } from 'solid-js';
import { FIXTURE_MODE } from '../lib/fixture/flag.ts';
import { buildReport, fetchFingerprint, type FingerprintReport } from '../lib/fingerprint.ts';
import { schema } from '../lib/admin-store.ts';

/**
 * Read-only "Schema status": which migrations the live database has applied.
 * Uses the optional schema_fingerprint() function (migration 019). Without it the
 * panel says "unknown" and falls back to what the loaded rows reveal; it never
 * affects the rest of the dashboard.
 */
export function SchemaStatus(): JSX.Element {
  const [report] = createResource<FingerprintReport>(() =>
    FIXTURE_MODE ? Promise.resolve(buildReport(null, 'fixture mode')) : fetchFingerprint(),
  );
  const summary = () => {
    const r = report();
    if (!r) return 'checking...';
    if (r.status === 'unavailable') return 'unknown';
    return r.missing.length === 0
      ? 'all migrations present'
      : `${r.missing.length} missing: ${[...new Set(r.missing.map((m) => m.migration))].join(', ')}`;
  };
  const bad = () => (report()?.missing.length ?? 0) > 0;

  return (
    <details class="definitions schema-status">
      <summary>
        Schema status: <span classList={{ 'schema-status__bad': bad() }}>{summary()}</span>
      </summary>
      <Show
        when={report()?.status === 'ok'}
        fallback={
          <p class="note">
            Unknown: the fingerprint function is not installed ({report()?.reason ?? 'loading'}).
            Production migrations are applied by hand; apply{' '}
            <code>supabase/migrations/019_schema_fingerprint.sql</code> to enable this panel, or run
            the fingerprint query in <code>supabase/README.md</code>.
            <Show when={schema().messages.length > 0}>
              {' '}
              Missing columns detected from the loaded data: {schema().messages.join(' ')}
            </Show>
          </p>
        }
      >
        <ul>
          <For each={report()?.rows ?? []}>
            {(r) => (
              <li classList={{ 'schema-status__bad': r.state === 'missing' && !r.optional }}>
                <code>{r.migration}</code> {r.label}:{' '}
                <strong>
                  {r.state === 'ok'
                    ? 'present'
                    : r.state === 'missing'
                      ? r.optional
                        ? 'absent (optional)'
                        : 'MISSING'
                      : 'unknown'}
                </strong>
              </li>
            )}
          </For>
        </ul>
        <p class="note">
          Read-only checks of the live database; nothing is modified. A MISSING row means that
          migration (or part of it) was not applied by hand.
        </p>
      </Show>
    </details>
  );
}
