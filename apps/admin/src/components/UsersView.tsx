import { type JSX, createMemo, createSignal, For, Show } from 'solid-js';
import { SegmentedControl } from '@calab/ui';
import { ChartCard, Empty } from './charts/ChartCard.tsx';
import { StackedColumns } from './charts/StackedColumns.tsx';
import { DataTable } from './DataTable.tsx';
import { Drawer } from './Drawer.tsx';
import { slot } from './charts/palette.ts';
import { cur, dataset, events, nowMs, scopedAll, win } from '../lib/admin-store.ts';
import {
  appLabel,
  browserActivity,
  browserTimeline,
  cohortRetention,
  newVsReturning,
  type BrowserActivity,
} from '../lib/metrics.ts';
import { buildCala, testerTable } from '../lib/cala.ts';
import { type Bucket, fmtNum, fmtPct } from '../lib/stats.ts';
import { utcDay } from '../lib/filters.ts';

const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

export function UsersView(): JSX.Element {
  const [bucket, setBucket] = createSignal<Bucket>('day');
  const [open, setOpen] = createSignal<BrowserActivity | null>(null);

  const nvr = createMemo(() =>
    newVsReturning(scopedAll(), cur(), bucket(), win().curStart, win().curEnd),
  );
  const cohorts = createMemo(() => cohortRetention(scopedAll(), nowMs()));
  const active = createMemo(() => browserActivity(cur(), events()));
  const testers = createMemo(() => {
    const c = buildCala(cur(), events());
    return testerTable(c.sessions, c.idx);
  });
  const timeline = createMemo(() => {
    const b = open();
    return b ? browserTimeline(b.userId, cur(), dataset.latest?.events ?? []) : [];
  });

  return (
    <div class="view">
      <p class="note">
        A "browser" is one <code>user_id</code>: a browser profile, not a person. It resets when
        site data is cleared, so returning rates are a lower bound. First seen means first seen in
        the loaded data.
      </p>
      <ChartCard
        title="New vs returning browsers"
        subtitle={`Active browsers per ${bucket()} (UTC). New = first seen in that ${bucket()}.`}
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
          columns: ['Bucket', 'New', 'Returning'],
          rows: nvr().map((p) => [p.bucket, p.new, p.returning]),
        }}
      >
        <Show when={active().length > 0} fallback={<Empty />}>
          <StackedColumns
            ariaLabel="New and returning browsers over time"
            categories={nvr().map((p) => p.bucket)}
            series={[
              { key: 'new', label: 'New', color: slot(1), values: nvr().map((p) => p.new) },
              {
                key: 'ret',
                label: 'Returning',
                color: slot(2),
                values: nvr().map((p) => p.returning),
              },
            ]}
          />
        </Show>
      </ChartCard>

      <ChartCard
        title="Retention by first-seen week"
        subtitle="Share of each cohort with a session in week +N (UTC weeks, Monday start)"
      >
        <Show when={cohorts().length > 0} fallback={<Empty />}>
          <div class="data-table-wrap">
            <table class="data-table cohort">
              <caption class="sr-only">Retention by first-seen week</caption>
              <thead>
                <tr>
                  <th class="data-table__th">Cohort week</th>
                  <th class="data-table__th num">Browsers</th>
                  <For each={cohorts()[0].retention}>
                    {(_, k) => <th class="data-table__th num">+{k()}</th>}
                  </For>
                </tr>
              </thead>
              <tbody>
                <For each={cohorts()}>
                  {(c) => (
                    <tr>
                      <td class="data-table__td">{c.week}</td>
                      <td class="data-table__td num">{fmtNum(c.size)}</td>
                      <For each={c.retention}>
                        {(r) => (
                          <td
                            class="data-table__td num cohort__cell"
                            style={{
                              '--shade': r === null ? 0 : Math.min(1, r) * 0.85,
                            }}
                            title={r === null ? 'Not yet' : `${fmtPct(r)} of ${c.size}`}
                          >
                            {r === null ? '' : fmtPct(r)}
                          </td>
                        )}
                      </For>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </ChartCard>

      <h2 class="view__title">Most active browsers</h2>
      <p class="note">Short hashes only. Select a row for that browser's sessions and events.</p>
      <DataTable
        caption="Most active browsers"
        pageSize={15}
        searchable
        defaultSort={{ key: 'sessions', asc: false }}
        onRowClick={(r) => setOpen(r as BrowserActivity)}
        columns={[
          { key: 'hash', label: 'Browser' },
          { key: 'sessions', label: 'Sessions', bar: true },
          { key: 'events', label: 'Events', align: 'right' },
          { key: 'days', label: 'Active days', align: 'right' },
          {
            key: 'apps',
            label: 'Apps',
            format: (r) => (r.apps as string[]).map(appLabel).join(', '),
          },
          { key: 'country', label: 'Country' },
          { key: 'firstMs', label: 'First seen', format: (r) => utcDay(r.firstMs) },
          { key: 'lastMs', label: 'Last seen', format: (r) => utcDay(r.lastMs) },
        ]}
        rows={active()}
        emptyText="No browsers for this filter."
      />

      <h2 class="view__title">Testers</h2>
      <p class="note">
        Beta testers who typed a tag in Cala (opt-in). Tags are free text typed by users and are
        shown as plain text. Joined to runs through the session id; only Cala sessions carry tags.
      </p>
      <DataTable
        caption="Testers by tag"
        defaultSort={{ key: 'lastSeen', asc: false }}
        columns={[
          { key: 'tag', label: 'Tag' },
          { key: 'sessions', label: 'Sessions', align: 'right' },
          { key: 'runs', label: 'Runs', align: 'right' },
          { key: 'failures', label: 'Failures', align: 'right' },
          {
            key: 'medianFps',
            label: 'Median fps',
            align: 'right',
            format: (r) => (r.medianFps === null ? '-' : fmtNum(r.medianFps, 1)),
          },
          { key: 'lastSeen', label: 'Last seen', format: (r) => when(r.lastSeen) },
          { key: 'versions', label: 'Versions' },
        ]}
        rows={testers()}
        emptyText="No tester tags in this range."
      />

      <Show when={open()}>
        {(b) => (
          <Drawer title={`Browser ${b().hash}`} onClose={() => setOpen(null)}>
            <p class="note">
              {b().sessions} sessions on {b().days} days, {b().events} events. {b().country ?? ''}
              {b().signedIn ? ' Signed in at least once.' : ''}
            </p>
            <ol class="timeline">
              <For each={timeline()}>
                {(i) => (
                  <li class={`timeline__item timeline__item--${i.kind}`}>
                    <time>{when(i.ms)}</time>
                    <span class="timeline__label">{i.label}</span>
                    <span class="timeline__detail">{i.detail}</span>
                  </li>
                )}
              </For>
            </ol>
          </Drawer>
        )}
      </Show>
    </div>
  );
}
