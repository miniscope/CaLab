import { type JSX, createMemo, createSignal, For, Show } from 'solid-js';
import { SegmentedControl } from '@calab/ui';
import { ChartCard, Empty } from './charts/ChartCard.tsx';
import { StackedColumns } from './charts/StackedColumns.tsx';
import { HBars } from './charts/HBars.tsx';
import { Funnel } from './charts/Funnel.tsx';
import { DataTable, type Column } from './DataTable.tsx';
import { appColor, slot } from './charts/palette.ts';
import { apps, cur, events, filters, scopedAll, win } from '../lib/admin-store.ts';
import {
  appFunnel,
  appLabel,
  browserMix,
  eventMatrix,
  eventsOverTime,
  indexEvents,
  referrerTable,
  screenMix,
  tutorialRates,
} from '../lib/metrics.ts';
import { type Bucket, fmtPct } from '../lib/stats.ts';

function tutorialColumns(hasCompleted: boolean): Column[] {
  const cols: Column[] = [
    { key: 'tutorial', label: 'Tutorial' },
    { key: 'started', label: 'Started', bar: true },
  ];
  if (hasCompleted) {
    cols.push(
      { key: 'completed', label: 'Completed', align: 'right' },
      {
        key: 'rate',
        label: 'Completion',
        align: 'right',
        format: (r) => fmtPct(r.started > 0 ? r.completed / r.started : null),
      },
    );
  }
  return cols;
}

export function UsageView(): JSX.Element {
  const [bucket, setBucket] = createSignal<Bucket>('day');
  const matrix = createMemo(() => eventMatrix(cur(), events()));
  const series = createMemo(() =>
    eventsOverTime(cur(), events(), bucket(), win().curStart, win().curEnd),
  );
  const idx = createMemo(() => indexEvents(cur(), events()));
  const funnelApps = () =>
    ['catune', 'cadecon'].filter((a) => filters().app === 'all' || filters().app === a);
  const tutorials = createMemo(() => tutorialRates(events()));
  const refs = createMemo(() => referrerTable(cur(), scopedAll()));

  return (
    <div class="view">
      <ChartCard
        title="Events by type"
        subtitle="Split by app"
        legend={matrix().apps.map((a) => ({ label: appLabel(a), color: appColor(a, apps()) }))}
        table={{
          columns: ['Event', 'Total', ...matrix().apps.map(appLabel)],
          rows: matrix().rows.map((r) => [r.event, r.total, ...r.byApp]),
        }}
      >
        <Show when={matrix().rows.length > 0} fallback={<Empty />}>
          <HBars
            rows={matrix().rows.map((r) => ({
              label: r.event,
              value: r.total,
              segments: matrix()
                .apps.map((a, i) => ({
                  label: appLabel(a),
                  value: r.byApp[i],
                  color: appColor(a, apps()),
                }))
                .filter((s) => s.value > 0),
            }))}
          />
        </Show>
      </ChartCard>

      <ChartCard
        title="Events over time"
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
      >
        <Show when={events().length > 0} fallback={<Empty />}>
          <StackedColumns
            ariaLabel="Events over time, stacked by app"
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

      <div class="grid-2">
        <For each={funnelApps()}>
          {(app) => {
            const steps = () =>
              appFunnel(app, cur(), idx()).map((s, i, all) => ({
                label: s.label,
                count: s.count,
                ofFirst: all[0].count > 0 ? s.count / all[0].count : null,
                ofPrev: i > 0 && all[i - 1].count > 0 ? s.count / all[i - 1].count : null,
              }));
            return (
              <ChartCard
                title={`${appLabel(app)} funnel`}
                subtitle="Sessions reaching each step; steps use any of the listed events"
                table={{
                  columns: ['Step', 'Sessions', '% of visited', '% of previous'],
                  rows: steps().map((s) => [s.label, s.count, fmtPct(s.ofFirst), fmtPct(s.ofPrev)]),
                }}
              >
                <Show when={steps()[0]?.count > 0} fallback={<Empty />}>
                  <Funnel steps={steps()} />
                </Show>
              </ChartCard>
            );
          }}
        </For>
        <ChartCard title="Tutorials" subtitle="tutorial_started by tutorial id">
          <Show when={tutorials().rows.length > 0} fallback={<Empty text="No tutorial events." />}>
            <DataTable
              caption="Tutorial starts and completions"
              defaultSort={{ key: 'started', asc: false }}
              columns={tutorialColumns(tutorials().hasCompleted)}
              rows={tutorials().rows}
            />
            <Show when={!tutorials().hasCompleted}>
              <p class="note">
                No tutorial_completed events exist yet, so completion rates are not shown.
              </p>
            </Show>
          </Show>
        </ChartCard>
      </div>

      <h2 class="view__title">Referrers</h2>
      <p class="note">
        First touch = the referrer of a browser's earliest session in the loaded data ("Direct" =
        none sent). Sessions = every session with that referrer.
      </p>
      <DataTable
        caption="Referrer domains"
        pageSize={15}
        searchable
        defaultSort={{ key: 'sessions', asc: false }}
        columns={[
          { key: 'referrer', label: 'Referrer' },
          { key: 'sessions', label: 'Sessions', bar: true },
          { key: 'firstTouch', label: 'First touch', align: 'right' },
        ]}
        rows={refs()}
      />

      <div class="grid-2">
        <ChartCard title="Browsers" subtitle="Sessions by browser family">
          <HBars
            rows={browserMix(cur()).map((b) => ({ label: b.key, value: b.count, color: slot(1) }))}
          />
        </ChartCard>
        <ChartCard title="Screen widths" subtitle="Sessions by screen class">
          <HBars
            rows={screenMix(cur()).map((b) => ({ label: b.key, value: b.count, color: slot(1) }))}
          />
        </ChartCard>
      </div>
    </div>
  );
}
