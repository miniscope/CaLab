import { type JSX, createMemo, Show } from 'solid-js';
import { ChartCard, Empty } from './charts/ChartCard.tsx';
import { HBars } from './charts/HBars.tsx';
import { DataTable } from './DataTable.tsx';
import { appColor } from './charts/palette.ts';
import { apps, cur, scopedAll } from '../lib/admin-store.ts';
import { appLabel, countryName, countryTable, regionTable } from '../lib/metrics.ts';
import { fmtNum, sortApps } from '../lib/stats.ts';

export function GeographyView(): JSX.Element {
  const countries = createMemo(() => countryTable(cur(), scopedAll()));
  const regions = createMemo(() => regionTable(cur()));
  const top = () => countries().slice(0, 15);
  const appKeys = createMemo(() => sortApps(new Set(cur().map((s) => s.app_name))));

  return (
    <div class="view">
      <ChartCard
        title="Sessions by country"
        subtitle="Top 15, split by app"
        legend={appKeys().map((a) => ({ label: appLabel(a), color: appColor(a, apps()) }))}
        table={{
          columns: ['Country', 'Sessions', 'Browsers', 'First seen here'],
          rows: countries().map((c) => [
            countryName(c.country),
            c.sessions,
            c.browsers,
            c.firstSeen,
          ]),
        }}
      >
        <Show when={countries().length > 0} fallback={<Empty />}>
          <HBars
            rows={top().map((c) => ({
              label: countryName(c.country),
              value: c.sessions,
              segments: appKeys()
                .filter((a) => c.byApp[a])
                .map((a) => ({
                  label: appLabel(a),
                  value: c.byApp[a],
                  color: appColor(a, apps()),
                })),
            }))}
          />
        </Show>
      </ChartCard>
      <h2 class="view__title">Countries</h2>
      <p class="note">
        "First seen here" counts browsers whose earliest session in the loaded data came from that
        country; it does not depend on time zones. Geography comes from the geo-session function,
        which resolves country and region server-side and stores no IP address.
      </p>
      <DataTable
        caption="Countries"
        pageSize={20}
        searchable
        defaultSort={{ key: 'sessions', asc: false }}
        columns={[
          { key: 'name', label: 'Country' },
          { key: 'sessions', label: 'Sessions', bar: true },
          { key: 'browsers', label: 'Browsers', align: 'right' },
          { key: 'firstSeen', label: 'First seen here', align: 'right' },
        ]}
        rows={countries().map((c) => ({ ...c, name: countryName(c.country) }))}
      />
      <h2 class="view__title">Regions</h2>
      <DataTable
        caption="Regions"
        pageSize={20}
        searchable
        defaultSort={{ key: 'sessions', asc: false }}
        columns={[
          { key: 'name', label: 'Country' },
          { key: 'region', label: 'Region' },
          { key: 'sessions', label: 'Sessions', bar: true },
        ]}
        rows={regions().map((r) => ({ ...r, name: countryName(r.country) }))}
      />
      <p class="note">
        {fmtNum(countries().length)} countries in range. No map: a ranked list reads more precisely.
      </p>
    </div>
  );
}
