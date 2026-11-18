import { type JSX, createMemo, createSignal, For, Show } from 'solid-js';
import { SegmentedControl } from '@calab/ui';
import { MetricCard } from './MetricCard.tsx';
import { ChartCard, Empty } from './charts/ChartCard.tsx';
import { StackedColumns } from './charts/StackedColumns.tsx';
import { HBars } from './charts/HBars.tsx';
import { Funnel } from './charts/Funnel.tsx';
import { DataTable } from './DataTable.tsx';
import { slot, NEUTRAL } from './charts/palette.ts';
import { curAnyVersion, cur, eventsAnyVersion, events, win } from '../lib/admin-store.ts';
import {
  type AdapterClass,
  adapterTable,
  boundaryStats,
  buildCala,
  failureTable,
  flagRegressions,
  fpsByAdapterClass,
  runsOverTime,
  sizeDistributions,
  stageModeTable,
  versionComparison,
  extractFailures,
  extractRuns,
  pairRuns,
  unfinishedTable,
} from '../lib/cala.ts';
import { browserMix, indexEvents } from '../lib/metrics.ts';
import {
  type HwGroup,
  buildProfiles,
  coresBucket,
  gpuClass,
  hardwareGroups,
  hardwareMixes,
  maxBufferBucket,
  memoryClass,
  peakMemoryBySize,
} from '../lib/hardware.ts';
import { type Bucket, fmtDuration, fmtNum, fmtPct, median } from '../lib/stats.ts';

const ADAPTER_COLOR: Record<AdapterClass, string> = {
  hardware: slot(1),
  fallback: slot(2),
  none: NEUTRAL,
  unknown: NEUTRAL,
};
const ADAPTER_LABEL: Record<AdapterClass, string> = {
  hardware: 'Hardware GPU',
  fallback: 'Software fallback',
  none: 'No WebGPU',
  unknown: 'Not reported',
};
const STAGE_COLOR: Record<string, string> = {
  discover: slot(1),
  refine: slot(2),
  extract: slot(3),
};

const fps = (n: number | null) => (n === null ? '-' : fmtNum(n, 1));

const pct = (x: number | null) => fmtPct(x, 0);

function HwTable(props: { caption: string; rows: HwGroup[]; showSmall: boolean }): JSX.Element {
  const shown = () => props.rows.filter((r) => props.showSmall || !r.small);
  const hidden = () => props.rows.length - shown().length;
  return (
    <div>
      <DataTable
        caption={props.caption}
        defaultSort={{ key: 'n', asc: false }}
        columns={[
          { key: 'group', label: 'Group' },
          { key: 'n', label: 'n (starts)', align: 'right' },
          {
            key: 'discoverFps',
            label: 'Discover fps',
            align: 'right',
            format: (r) => fps(r.discoverFps),
          },
          {
            key: 'refineFps',
            label: 'Refine fps',
            align: 'right',
            format: (r) => fps(r.refineFps),
          },
          {
            key: 'failureRate',
            label: 'Failed',
            align: 'right',
            format: (r) => pct(r.failureRate),
          },
          {
            key: 'unfinishedRate',
            label: 'Unfinished',
            align: 'right',
            format: (r) => pct(r.unfinishedRate),
          },
        ]}
        rows={shown()}
        emptyText="No groups with enough runs (try showing small groups)."
      />
      <Show when={hidden() > 0}>
        <p class="note">{hidden()} group(s) with n under 3 hidden.</p>
      </Show>
    </div>
  );
}

export function CalaView(): JSX.Element {
  const [bucket, setBucket] = createSignal<Bucket>('day');
  const [showSmall, setShowSmall] = createSignal(false);
  const cala = createMemo(() => buildCala(cur(), events()));
  const idx = () => cala().idx;

  // Version comparison ignores the version filter on purpose.
  const versionRows = createMemo(() => {
    const sessions = curAnyVersion().filter((s) => s.app_name === 'cala');
    const ix = indexEvents(sessions, eventsAnyVersion());
    return versionComparison(
      sessions,
      extractRuns(sessions, ix),
      extractFailures(sessions, ix),
      pairRuns(sessions, ix),
    );
  });
  const flags = createMemo(() => flagRegressions(versionRows()));

  const runs = () => cala().runs;
  const attempts = () => runs().length + cala().failures.length;
  const failRate = () => (attempts() > 0 ? cala().failures.length / attempts() : null);
  const hwFps = () =>
    median(
      runs()
        .filter((r) => r.adapter === 'hardware')
        .map((r) => r.medianFps),
    );
  const dist = createMemo(() => sizeDistributions(runs()));
  const series = createMemo(() => runsOverTime(runs(), bucket(), win().curStart, win().curEnd));
  const stageRows = createMemo(() => stageModeTable(runs()));
  const failures = createMemo(() => failureTable(cala().failures));
  const profiles = createMemo(() => buildProfiles(cala().sessions, idx()));
  const mixes = createMemo(() => hardwareMixes(cala().sessions, profiles()));
  const groupBy = (key: Parameters<typeof hardwareGroups>[0]) =>
    hardwareGroups(key, profiles(), runs(), cala().failures, cala().ledger);
  const byGpu = createMemo(() => groupBy(gpuClass));
  const byCores = createMemo(() => groupBy((p) => coresBucket(p.cores)));
  const byMemory = createMemo(() => groupBy((p) => memoryClass(p.memoryGb)));
  const byBuffer = createMemo(() => groupBy((p) => maxBufferBucket(p.maxBufferMb)));
  const byOs = createMemo(() => groupBy((p) => p.os));
  const peak = createMemo(() => peakMemoryBySize(runs()));
  const unfinishedRows = createMemo(() => unfinishedTable(cala().ledger));
  const unfinishedRate = () =>
    cala().ledger.starts.length > 0
      ? cala().ledger.unfinished.length / cala().ledger.starts.length
      : null;
  const bounds = createMemo(() => boundaryStats(cala().sessions, idx()));
  const adapters = createMemo(() => adapterTable(cala().sessions, idx(), runs()));
  const adapterFps = createMemo(() => fpsByAdapterClass(runs()));
  const fallbackShare = createMemo(() => {
    const t = adapters().reduce((a, r) => a + r.sessions, 0);
    const f = adapters()
      .filter((r) => r.cls !== 'hardware')
      .reduce((a, r) => a + r.sessions, 0);
    return t > 0 ? f / t : null;
  });
  const hist = (
    id: string,
    title: string,
    bins: { label: string; count: number }[],
    unit: string,
  ) => (
    <ChartCard
      title={title}
      subtitle={`${fmtNum(bins.reduce((a, b) => a + b.count, 0))} runs${unit ? `, ${unit}` : ''}`}
      table={{ columns: ['Bin', 'Runs'], rows: bins.map((b) => [b.label, b.count]) }}
    >
      <Show when={bins.length > 0} fallback={<Empty text="Not reported in this range." />}>
        <StackedColumns
          height={140}
          ariaLabel={`${title} histogram`}
          categories={bins.map((b) => b.label)}
          series={[{ key: id, label: 'Runs', color: slot(1), values: bins.map((b) => b.count) }]}
        />
      </Show>
    </ChartCard>
  );

  return (
    <div class="view">
      <Show when={cala().sessions.length === 0}>
        <Empty text="No Cala sessions for this filter (the app filter may exclude Cala)." />
      </Show>
      <Show when={cala().sessions.length > 0}>
        <div class="metric-grid">
          <MetricCard label="Cala sessions" value={fmtNum(cala().sessions.length)} />
          <MetricCard label="Runs finished" value={fmtNum(runs().length)} />
          <MetricCard
            label="Failure rate"
            value={fmtPct(failRate(), 1)}
            hint="run_failed / (run_finished + run_failed)."
          />
          <MetricCard
            label="Median fps (GPU)"
            value={fps(hwFps())}
            hint="Median of per-run median_fps, hardware adapters only. Software fallback runs are listed separately below."
          />
          <MetricCard
            label="Unfinished runs"
            value={fmtPct(unfinishedRate(), 1)}
            hint="run_started with no run_finished or run_failed in the same session: a crashed tab (out of memory cannot report), a closed or reloaded tab, or a run the user stopped. A rate, not a failure count."
          />
          <MetricCard
            label="Median run time"
            value={fmtDuration(median(runs().map((r) => r.durationS)))}
          />
          <MetricCard label="Median cells" value={fmtNum(median(runs().map((r) => r.cells)))} />
        </div>

        <Show when={flags().length > 0}>
          <div class="banner banner--warn" role="alert">
            <strong>Possible regression</strong>
            <For each={flags()}>
              {(f) => (
                <span>
                  {' '}
                  {f.version} vs {f.against}: {f.reasons.join('; ')}.
                </span>
              )}
            </For>
          </div>
        </Show>

        <div class="grid-2">
          <ChartCard
            title="Funnel"
            subtitle="Sessions that reached each step (a session counts once per step)"
            table={{
              columns: ['Step', 'Sessions', '% of visited', '% of previous'],
              rows: cala().funnel.map((s) => [
                s.label,
                s.count,
                fmtPct(s.ofFirst),
                fmtPct(s.ofPrev),
              ]),
            }}
          >
            <Funnel steps={cala().funnel} />
          </ChartCard>
          <ChartCard
            title="Runs by stage and mode"
            subtitle="Finished runs and sessions processed; a Joint run is one run over all its sessions"
            table={{
              columns: ['Stage', 'Mode', 'Runs', 'Sessions', 'Median fps', 'Median s'],
              rows: stageRows().map((r) => [
                r.stage,
                r.mode,
                r.runs,
                r.sessions,
                fps(r.medianFps),
                fmtNum(r.medianDuration),
              ]),
            }}
          >
            <DataTable
              caption="Finished Cala runs and the sessions they processed, by stage and mode"
              defaultSort={{ key: 'runs', asc: false }}
              columns={[
                { key: 'stage', label: 'Stage' },
                { key: 'mode', label: 'Mode' },
                { key: 'runs', label: 'Runs', bar: true },
                { key: 'sessions', label: 'Sessions', align: 'right' },
                {
                  key: 'medianFps',
                  label: 'Median fps',
                  align: 'right',
                  format: (r) => fps(r.medianFps),
                },
                {
                  key: 'medianDuration',
                  label: 'Median time',
                  align: 'right',
                  format: (r) => fmtDuration(r.medianDuration),
                },
              ]}
              rows={stageRows()}
              emptyText="No finished runs in this range."
            />
          </ChartCard>
        </div>

        <ChartCard
          title="Runs over time"
          subtitle={`Finished runs per ${bucket()}, by stage`}
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
            columns: ['Bucket', ...series().series.map((s) => s.key)],
            rows: series().buckets.map((b, i) => [b, ...series().series.map((s) => s.values[i])]),
          }}
        >
          <Show
            when={runs().length > 0}
            fallback={<Empty text="No finished runs in this range." />}
          >
            <StackedColumns
              ariaLabel="Finished Cala runs over time, stacked by stage"
              categories={series().buckets}
              series={series().series.map((s) => ({
                key: s.key,
                label: s.key,
                color: STAGE_COLOR[s.key] ?? NEUTRAL,
                values: s.values,
              }))}
            />
          </Show>
        </ChartCard>

        <h2 class="view__title">Recording size and results</h2>
        <div class="grid-3">
          {hist('frames', 'Frames per run', dist().frames, '')}
          {hist('mp', 'Megapixels per frame', dist().megapixels, 'width x height / 1e6')}
          {hist('ses', 'Recordings per run', dist().sessionsPerRun, '')}
          {hist('cells', 'Cells found', dist().cells, '')}
          {hist(
            'wasm',
            'Peak WASM heap (MB)',
            dist().peakWasmMb,
            'main thread only, where reported',
          )}
        </div>

        <h2 class="view__title">WebGPU and browsers</h2>
        <Show when={fallbackShare() !== null && fallbackShare()! > 0.05}>
          <div class="banner banner--warn" role="note">
            {fmtPct(fallbackShare())} of sessions that reported an adapter are not on a hardware GPU
            (software fallback or no WebGPU). Software rendering is the usual cause of very low fps.
          </div>
        </Show>
        <div class="grid-2">
          <ChartCard
            title="Adapter mix"
            subtitle="Sessions by adapter class and vendor"
            table={{
              columns: ['Class', 'Vendor', 'Sessions', 'Runs', 'Median fps'],
              rows: adapters().map((a) => [
                ADAPTER_LABEL[a.cls],
                a.vendor,
                a.sessions,
                a.runs,
                fps(a.medianFps),
              ]),
            }}
          >
            <Show
              when={adapters().length > 0}
              fallback={<Empty text="No webgpu_info events in this range." />}
            >
              <HBars
                rows={adapters().map((a) => ({
                  label: `${ADAPTER_LABEL[a.cls]}: ${a.vendor}`,
                  value: a.sessions,
                  color: ADAPTER_COLOR[a.cls],
                }))}
              />
            </Show>
          </ChartCard>
          <ChartCard
            title="Median fps by adapter class"
            subtitle="Per-run median_fps; a low software bar means software rendering"
            table={{
              columns: ['Class', 'Runs', 'Median fps'],
              rows: adapterFps().map((a) => [ADAPTER_LABEL[a.cls], a.runs, fps(a.medianFps)]),
            }}
          >
            <Show
              when={adapterFps().length > 0}
              fallback={<Empty text="No finished runs in this range." />}
            >
              <HBars
                format={(n) => fmtNum(n, 1)}
                rows={adapterFps().map((a) => ({
                  label: ADAPTER_LABEL[a.cls],
                  value: a.medianFps ?? 0,
                  note: `${a.runs} runs`,
                  color: ADAPTER_COLOR[a.cls],
                }))}
              />
            </Show>
          </ChartCard>
          <ChartCard title="Browsers" subtitle="Cala sessions by browser family">
            <HBars
              rows={browserMix(cala().sessions).map((b) => ({
                label: b.key,
                value: b.count,
                color: slot(1),
              }))}
            />
          </ChartCard>
          <ChartCard
            title="Multi-recording boundaries"
            subtitle="Joint runs that stitched more than one recording"
          >
            <Show
              when={bounds().runs > 0}
              fallback={<Empty text="No multi-recording Joint runs in this range." />}
            >
              <p class="stat-line">
                <strong>{fmtPct(bounds().flaggedShare)}</strong> of {fmtNum(bounds().runs)} runs had
                a boundary flagged ({bounds().withWarning} with a warning, {bounds().withFailed}{' '}
                with a failure).
              </p>
            </Show>
          </ChartCard>
        </div>

        <h2 class="view__title">Hardware</h2>
        <p class="note">
          From device_info and webgpu_info, joined to runs by session. Older Cala versions send
          neither, so they appear as Unknown. n is the number of runs started in the group; rates
          over a handful of runs are noise, so groups with n under 3 are hidden unless you show
          them.
          <label class="filters__check">
            <input
              type="checkbox"
              checked={showSmall()}
              onChange={(e) => setShowSmall(e.currentTarget.checked)}
            />
            Show small groups
          </label>
        </p>
        <Show
          when={mixes().withDeviceInfo > 0 || mixes().gpu.length > 0}
          fallback={
            <Empty text="No hardware events in this range (needs a Cala version that sends device_info)." />
          }
        >
          <div class="grid-3">
            <ChartCard title="Operating system" subtitle="Sessions">
              <HBars
                rows={mixes().os.map((r) => ({ label: r.key, value: r.count, color: slot(1) }))}
              />
            </ChartCard>
            <ChartCard title="CPU cores" subtitle="Sessions (navigator.hardwareConcurrency)">
              <HBars
                rows={mixes().cores.map((r) => ({ label: r.key, value: r.count, color: slot(1) }))}
              />
            </ChartCard>
            <ChartCard
              title="Memory class"
              subtitle="Sessions (navigator.deviceMemory, capped by the browser)"
            >
              <HBars
                rows={mixes().memory.map((r) => ({ label: r.key, value: r.count, color: slot(1) }))}
              />
            </ChartCard>
            <ChartCard
              title="GPU vendor and architecture"
              subtitle="Sessions; software and missing WebGPU highlighted"
            >
              <HBars
                rows={mixes().gpu.map((r) => ({
                  label: r.key,
                  value: r.count,
                  color: r.fallback ? slot(2) : slot(1),
                }))}
              />
            </ChartCard>
            <ChartCard title="Browser and major version" subtitle="Sessions">
              <HBars
                rows={mixes().browser.map((r) => ({
                  label: r.key,
                  value: r.count,
                  color: slot(1),
                }))}
              />
            </ChartCard>
          </div>
          <h3 class="card__title">Performance and reliability by hardware</h3>
          <div class="grid-2">
            <ChartCard
              title="By GPU class"
              subtitle="Median fps per stage, failed and unfinished rates"
            >
              <HwTable caption="Runs by GPU class" rows={byGpu()} showSmall={showSmall()} />
            </ChartCard>
            <ChartCard title="By CPU cores" subtitle="Same metrics">
              <HwTable caption="Runs by CPU core count" rows={byCores()} showSmall={showSmall()} />
            </ChartCard>
            <ChartCard title="By memory class" subtitle="Same metrics">
              <HwTable caption="Runs by memory class" rows={byMemory()} showSmall={showSmall()} />
            </ChartCard>
            <ChartCard
              title="By max buffer size"
              subtitle="WebGPU maxBufferSize reported by the adapter"
            >
              <HwTable
                caption="Runs by max buffer size"
                rows={byBuffer()}
                showSmall={showSmall()}
              />
            </ChartCard>
            <ChartCard title="By operating system" subtitle="Same metrics">
              <HwTable caption="Runs by operating system" rows={byOs()} showSmall={showSmall()} />
            </ChartCard>
            <ChartCard
              title="Peak memory by recording size"
              subtitle="Median peak_wasm_mb (all threads in newer versions) and peak_js_mb, where reported"
              table={{
                columns: ['Size (frames x MP)', 'n', 'WASM MB', 'JS MB'],
                rows: peak().map((b) => [b.label, b.n, fmtNum(b.wasmMb), fmtNum(b.jsMb)]),
              }}
            >
              <Show
                when={peak().length > 0}
                fallback={<Empty text="No peak memory values reported." />}
              >
                <StackedColumns
                  height={150}
                  ariaLabel="Median peak WASM memory by recording size"
                  categories={peak().map((b) => b.label.replace(' frames x MP', ''))}
                  series={[
                    {
                      key: 'wasm',
                      label: 'peak_wasm_mb',
                      color: slot(1),
                      values: peak().map((b) => b.wasmMb ?? 0),
                    },
                  ]}
                />
              </Show>
            </ChartCard>
          </div>
        </Show>

        <h2 class="view__title">Versions</h2>
        <div class="grid-3">
          <ChartCard
            title="Median fps by version"
            subtitle="Hardware-adapter runs only, oldest to newest (ignores the version filter)"
            table={{
              columns: ['Version', 'Median fps (GPU)', 'Median fps (all)', 'Runs'],
              rows: versionRows().map((v) => [
                v.version,
                fps(v.medianFpsHardware),
                fps(v.medianFps),
                v.runs,
              ]),
            }}
          >
            <Show when={versionRows().length > 0} fallback={<Empty />}>
              <StackedColumns
                height={150}
                ariaLabel="Median fps by Cala version"
                format={(n) => fmtNum(n, 1)}
                categories={versionRows().map((v) => v.version)}
                series={[
                  {
                    key: 'fps',
                    label: 'Median fps',
                    color: slot(1),
                    values: versionRows().map((v) => v.medianFpsHardware ?? 0),
                  },
                ]}
              />
            </Show>
          </ChartCard>
          <ChartCard
            title="Failure rate by version"
            subtitle="run_failed / (finished + failed)"
            table={{
              columns: ['Version', 'Failure rate', 'Failures', 'Finished'],
              rows: versionRows().map((v) => [
                v.version,
                fmtPct(v.failureRate, 1),
                v.failures,
                v.runs,
              ]),
            }}
          >
            <Show when={versionRows().length > 0} fallback={<Empty />}>
              <StackedColumns
                height={150}
                ariaLabel="Failure rate by Cala version"
                format={(n) => `${n.toFixed(0)}%`}
                categories={versionRows().map((v) => v.version)}
                series={[
                  {
                    key: 'fail',
                    label: 'Failure rate',
                    color: slot(2),
                    values: versionRows().map((v) => (v.failureRate ?? 0) * 100),
                  },
                ]}
              />
            </Show>
          </ChartCard>
          <ChartCard
            title="Unfinished rate by version"
            subtitle="run_started without a finish or failure (crash, closed tab or stop)"
            table={{
              columns: ['Version', 'Unfinished rate', 'Unfinished', 'Started'],
              rows: versionRows().map((v) => [
                v.version,
                fmtPct(v.unfinishedRate, 1),
                v.unfinished,
                v.starts,
              ]),
            }}
          >
            <Show when={versionRows().length > 0} fallback={<Empty />}>
              <StackedColumns
                height={150}
                ariaLabel="Unfinished run rate by Cala version"
                format={(n) => `${n.toFixed(0)}%`}
                categories={versionRows().map((v) => v.version)}
                series={[
                  {
                    key: 'unf',
                    label: 'Unfinished rate',
                    color: slot(4),
                    values: versionRows().map((v) => (v.unfinishedRate ?? 0) * 100),
                  },
                ]}
              />
            </Show>
          </ChartCard>
        </div>

        <h2 class="view__title">Unfinished runs</h2>
        <p class="note">
          A run that started but never reported a finish or a failure. Unfinished means a crash (a
          tab killed by an out-of-memory condition cannot send run_failed), a tab closed or
          reloaded, or a run the user stopped (cancelled runs emit nothing). Read it as a rate and
          watch version-to-version jumps. "Survived" is the session's last heartbeat (sent every
          minute while the tab is visible) minus the run start, so it is only accurate to about a
          minute and is empty when no heartbeat arrived.
        </p>
        <DataTable
          caption="Unfinished run rate by stage and version"
          defaultSort={{ key: 'rate', asc: false }}
          columns={[
            { key: 'stage', label: 'Stage' },
            { key: 'version', label: 'Version' },
            { key: 'starts', label: 'Started', align: 'right' },
            { key: 'unfinished', label: 'Unfinished', align: 'right' },
            { key: 'rate', label: 'Rate', align: 'right', format: (r) => fmtPct(r.rate, 0) },
            {
              key: 'medianSurvivedS',
              label: 'Median survived',
              align: 'right',
              format: (r) => fmtDuration(r.medianSurvivedS),
            },
            {
              key: 'medianWorkMpx',
              label: 'Median frames x MP',
              align: 'right',
              format: (r) => fmtNum(r.medianWorkMpx),
            },
          ]}
          rows={unfinishedRows()}
          emptyText="No run_started events in this range."
        />
        <DataTable
          caption="Unfinished runs"
          pageSize={10}
          defaultSort={{ key: 'startedAt', asc: false }}
          columns={[
            {
              key: 'startedAt',
              label: 'Started',
              format: (r) => new Date(r.startedAt).toISOString().slice(0, 16).replace('T', ' '),
            },
            { key: 'version', label: 'Version' },
            { key: 'stage', label: 'Stage' },
            { key: 'mode', label: 'Mode' },
            { key: 'recordings', label: 'Recordings', align: 'right' },
            { key: 'frames', label: 'Frames', align: 'right', format: (r) => fmtNum(r.frames) },
            {
              key: 'megapixels',
              label: 'MP',
              align: 'right',
              format: (r) => (r.megapixels === null ? '-' : r.megapixels.toFixed(2)),
            },
            {
              key: 'survivedS',
              label: 'Survived',
              align: 'right',
              format: (r) => fmtDuration(r.survivedS),
            },
            { key: 'adapter', label: 'Adapter' },
          ]}
          rows={cala().ledger.unfinished}
          emptyText="No unfinished runs in this range."
        />

        <h2 class="view__title">Failures</h2>
        <DataTable
          caption="Cala failures by stage, category and error type"
          defaultSort={{ key: 'count', asc: false }}
          columns={[
            { key: 'stage', label: 'Stage' },
            { key: 'category', label: 'Category' },
            { key: 'type', label: 'Error type' },
            { key: 'count', label: 'Count', bar: true },
            { key: 'versions', label: 'Versions' },
            {
              key: 'lastSeen',
              label: 'Last seen',
              format: (r) => new Date(r.lastSeen).toISOString().slice(0, 16).replace('T', ' '),
            },
          ]}
          rows={failures()}
          emptyText="No failures reported in this range."
        />
      </Show>
    </div>
  );
}
