import { For, Show, type JSX } from 'solid-js';
import { SegmentedControl } from '@calab/ui';
import { apps, dataset, filters, refresh, setFilters, versions, win } from '../lib/admin-store.ts';
import { type Filters, type Preset, rangeLabel, utcDay, DAY_MS } from '../lib/filters.ts';
import { appLabel, devSessionCount } from '../lib/metrics.ts';
import { FIXTURE_MODE } from '../lib/fixture/flag.ts';

export function FilterBar(): JSX.Element {
  const update = (patch: Partial<Filters>) =>
    setFilters((f) => {
      const next = { ...f, ...patch };
      if (patch.app !== undefined && patch.app !== f.app) next.version = 'all';
      return next;
    });

  const setPreset = (p: Preset) => {
    if (p === 'custom') {
      const w = win();
      update({
        preset: 'custom',
        start: utcDay(w.curStart > 0 ? w.curStart : Date.now() - 30 * DAY_MS),
        end: utcDay(w.curEnd - DAY_MS),
      });
    } else update({ preset: p });
  };

  const devCount = () => devSessionCount(dataset.latest?.sessions ?? []);

  return (
    <div class="filters" role="group" aria-label="Filters">
      <label class="filters__field">
        <span>App</span>
        <select value={filters().app} onChange={(e) => update({ app: e.currentTarget.value })}>
          <option value="all">All apps</option>
          <For each={apps()}>{(a) => <option value={a}>{appLabel(a)}</option>}</For>
        </select>
      </label>
      <div class="filters__field">
        <span>Range (UTC)</span>
        <SegmentedControl<Preset>
          aria-label="Date range"
          size="sm"
          value={filters().preset}
          onChange={setPreset}
          options={[
            { value: '7d', label: '7d' },
            { value: '30d', label: '30d' },
            { value: '90d', label: '90d' },
            { value: 'all', label: 'All' },
            { value: 'custom', label: 'Custom' },
          ]}
        />
      </div>
      <Show when={filters().preset === 'custom'}>
        <div class="filters__field filters__dates">
          <input
            type="date"
            aria-label="Start date"
            value={filters().start}
            onInput={(e) => update({ start: e.currentTarget.value })}
          />
          <span aria-hidden="true">to</span>
          <input
            type="date"
            aria-label="End date"
            value={filters().end}
            onInput={(e) => update({ end: e.currentTarget.value })}
          />
        </div>
      </Show>
      <label class="filters__field">
        <span>Version</span>
        <select
          value={filters().version}
          onChange={(e) => update({ version: e.currentTarget.value })}
        >
          <option value="all">All versions</option>
          <For each={versions()}>{(v) => <option value={v}>{v}</option>}</For>
        </select>
      </label>
      <label
        class="filters__check"
        title="Local builds (version dev) and localhost referrers are hidden by default"
      >
        <input
          type="checkbox"
          checked={filters().includeDev}
          onChange={(e) => update({ includeDev: e.currentTarget.checked })}
        />
        Include dev builds{devCount() > 0 ? ` (${devCount()})` : ''}
      </label>
      <div class="filters__meta">
        <span class="filters__range">{rangeLabel(filters(), win())}</span>
        <button class="btn-secondary" onClick={refresh} disabled={dataset.loading}>
          {dataset.loading ? 'Loading...' : 'Refresh'}
        </button>
        <Show when={FIXTURE_MODE}>
          <span class="badge" title="Synthetic data; Supabase is not contacted">
            FIXTURE
          </span>
        </Show>
      </div>
    </div>
  );
}
