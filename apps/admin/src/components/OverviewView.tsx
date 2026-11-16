import { type JSX, createMemo, createSignal, For, Show } from 'solid-js';
import { SegmentedControl } from '@calab/ui';
import { MetricCard } from './MetricCard.tsx';
import { ChartCard, Empty } from './charts/ChartCard.tsx';
import { StackedColumns } from './charts/StackedColumns.tsx';
import { appColor } from './charts/palette.ts';
import {
  apps,
  cadeconSubs,
  catuneSubs,
  cur,
  prev,
  prevSubs,
  schema,
  setActiveView,
  setFilters,
  win,
} from '../lib/admin-store.ts';
import {
  appLabel,
  computeOverview,
  overviewDeltas,
  perAppCards,
  sessionsOverTime,
} from '../lib/metrics.ts';
import { delta, fmtDuration, fmtNum, fmtPct, type Bucket } from '../lib/stats.ts';

export function OverviewView(): JSX.Element {
  const [bucket, setBucket] = createSignal<Bucket>('day');
  const o = createMemo(() => computeOverview(cur(), schema().anonKnown));
  const p = createMemo(() => (prev() ? computeOverview(prev()!, schema().anonKnown) : null));
  const d = createMemo(() => overviewDeltas(o(), p()));
  const subs = () => catuneSubs().length + cadeconSubs().length;
  const subsDelta = () => delta(subs(), prevSubs());
  const series = createMemo(() => sessionsOverTime(cur(), bucket(), win().curStart, win().curEnd));
  const cards = createMemo(() => perAppCards(cur()));

  return (
    <div class="view">
      <div class="metric-grid">
        <MetricCard
          label="Sessions"
          value={fmtNum(o().sessions)}
          delta={d().sessions}
          good="up"
          hint="One session = one page load of an app."
        />
        <MetricCard
          label="Unique browsers"
          value={fmtNum(o().browsers)}
          delta={d().browsers}
          good="up"
          hint="Distinct user_id (anonymous or signed in). Per browser profile, not per person; resets when site data is cleared."
        />
        <MetricCard
          label="Returning"
          value={fmtPct(o().returningRate)}
          delta={d().returningRate}
          points
          good="up"
          hint="Share of browsers with sessions on more than one UTC day in the range."
        />
        <MetricCard
          label="Signed-in accounts"
          value={o().signedIn === null ? 'n/a' : fmtNum(o().signedIn)}
          delta={o().signedIn === null ? null : d().signedIn}
          good="up"
          hint="Distinct non-anonymous user_id. n/a when the database has no is_anonymous column (migration 008)."
        />
        <MetricCard
          label="Median session"
          value={fmtDuration(o().medianDuration)}
          delta={d().medianDuration}
          good="neutral"
          deltaFormat={(n) => fmtDuration(n)}
          hint="Median of last heartbeat minus start. Sessions over 4 h are tabs left open and are excluded."
        />
        <MetricCard
          label="Submissions"
          value={fmtNum(subs())}
          delta={prevSubs() === null ? null : subsDelta()}
          good="up"
          hint="CaTune plus CaDecon community submissions in the range."
          onClick={() => setActiveView('submissions')}
        />
      </div>
      <Show when={o().noUserId > 0}>
        <p class="note">
          {fmtNum(o().noUserId)} older sessions have no user_id and are not counted as browsers.
        </p>
      </Show>

      <section aria-label="Apps">
        <h2 class="view__title">By app</h2>
        <div class="app-cards">
          <For each={cards()} fallback={<Empty />}>
            {(c) => (
              <div class="app-card">
                <div class="app-card__name">
                  <span class="legend__swatch" style={{ background: appColor(c.app, apps()) }} />
                  {appLabel(c.app)}
                </div>
                <div class="app-card__stats">
                  <span>
                    <strong>{fmtNum(c.sessions)}</strong> sessions
                  </span>
                  <span>
                    <strong>{fmtNum(c.browsers)}</strong> browsers
                  </span>
                  <span>
                    <strong>{fmtDuration(c.medianDuration)}</strong> median
                  </span>
                </div>
                <div class="app-card__links">
                  <button
                    class="link-btn"
                    onClick={() => setFilters((f) => ({ ...f, app: c.app, version: 'all' }))}
                  >
                    Filter to {appLabel(c.app)}
                  </button>
                  <Show when={c.app === 'cala'}>
                    <button class="link-btn" onClick={() => setActiveView('cala')}>
                      Cala tab
                    </button>
                  </Show>
                  <Show when={c.app === 'catune' || c.app === 'cadecon'}>
                    <button class="link-btn" onClick={() => setActiveView('submissions')}>
                      {fmtNum(c.app === 'catune' ? catuneSubs().length : cadeconSubs().length)}{' '}
                      submissions
                    </button>
                  </Show>
                </div>
              </div>
            )}
          </For>
        </div>
      </section>

      <ChartCard
        title="Sessions over time"
        subtitle={`Per ${bucket()} (UTC), by app`}
        actions={
          <SegmentedControl<Bucket>
            aria-label="Bucket size"
            size="sm"
            value={bucket()}
            onChange={setBucket}
            options={[
              { value: 'day', label: 'Daily' },
              { value: 'week', label: 'Weekly' },
            ]}
          />
        }
        table={{
          columns: ['Bucket', ...series().series.map((s) => appLabel(s.key))],
          rows: series().buckets.map((b, i) => [b, ...series().series.map((s) => s.values[i])]),
        }}
      >
        <Show when={series().buckets.length > 0 && cur().length > 0} fallback={<Empty />}>
          <StackedColumns
            ariaLabel="Sessions over time, stacked by app"
            categories={series().buckets}
            series={series().series.map((s) => ({
              key: s.key,
              label: appLabel(s.key),
              color: appColor(s.key, apps()),
              values: s.values,
            }))}
          />
        </Show>
      </ChartCard>

      <details class="definitions">
        <summary>Definitions and caveats</summary>
        <ul>
          <li>
            <strong>Unique browsers</strong>: distinct <code>user_id</code>. Supabase anonymous auth
            persists per browser profile (localStorage), so this counts browsers, not people, and
            the same person on two machines or after clearing site data counts again.
          </li>
          <li>
            <strong>Signed-in accounts</strong>: distinct non-anonymous <code>user_id</code>.
          </li>
          <li>
            <strong>Returning</strong>: a browser with sessions on more than one UTC day inside the
            selected range. New-versus-returning on the Users tab uses first seen in the loaded data
            (earlier visits before the range are invisible unless the range is All).
          </li>
          <li>
            <strong>Median session</strong>: last heartbeat (<code>ended_at</code>) minus start,
            falling back to <code>duration_seconds</code>; sessions over 4 h are excluded.
          </li>
          <li>
            <strong>Previous period</strong>: the equal-length period right before the range; the
            arrows compare against it. Not shown for All.
          </li>
        </ul>
      </details>
    </div>
  );
}
