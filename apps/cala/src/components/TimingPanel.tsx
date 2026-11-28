import { For, Show, type JSX } from 'solid-js';
import { HelpTip, Legend, Meter, RangeBar, StatusNote, pct, rangePosition } from '@calab/ui';
import { summarize, type CellStore, type Summary } from '../lib/cell-store.ts';
import type { PipelineStore } from '../lib/pipeline-store.ts';
import { createSampled } from '../lib/sampled.ts';

/** The Timing tab refreshes at most this often, ms (2 Hz). */
const SAMPLE_MS = 500;

/**
 * Declared domain of every timing bar, ms on a log scale: from the cheapest per-frame step
 * to a slow-loop batch, so all rows share one axis and a slow outlier never rescales the rest.
 */
export const TIMING_RANGE = { min: 0.01, max: 1000, scale: 'log' } as const;
/** Labelled ticks: every second decade, so the labels fit a phone-wide column. */
const TIMING_TICKS = [0.01, 1, 100];

/** `1.23` below 10 ms, `12.3` below 100, whole ms above. */
export function fmtMs(v: number): string {
  if (!Number.isFinite(v)) return '–';
  if (v < 10) return v.toFixed(2);
  if (v < 100) return v.toFixed(1);
  return Math.round(v).toLocaleString();
}

/** What the Timing tab shows, read at most at 2 Hz. */
interface TimingSnapshot {
  /** Real-time budget per frame at the recording's frame rate, ms. */
  budgetMs: number;
  stages: { label: string; key: string; ms: number }[];
  busy: { label: string; key: string; ms: number }[];
  throughputFps: number;
  perFrame: { label: string; key: string; s: Summary }[];
  qc: { label: string; key: string; s: Summary; perFrame: boolean }[];
  slow: { label: string; key: string; s: Summary }[];
  visits: { workers: number; jobs: number; inFlight: number; ms: number } | null;
  counters: {
    cells: number;
    adds: number;
    merges: number;
    refines: number;
    rejects: number;
    versions: number;
    added: number;
    removed: number;
    droppedPct: number;
    reservoirMb: number;
    framesPerTile: number;
    warning: string | null;
  } | null;
}

function readSnapshot(s: PipelineStore, c: CellStore): TimingSnapshot {
  const t = c.timing();
  const slow = c.slowTiming();
  const ms = s.stageMs();
  const busy = s.stageBusy();
  const st = c.status();
  let counters: TimingSnapshot['counters'] = null;
  if (st) {
    let added = 0;
    let removed = 0;
    const ev = c.events();
    for (const e of ev) {
      added += e.added;
      removed += e.removed;
    }
    const b = c.batch();
    const all = b ? b.forwardedFrames + b.droppedFrames : 0;
    counters = {
      cells: st.cells,
      adds: st.counters.adds,
      merges: st.counters.merges,
      refines: st.counters.refines,
      rejects: st.counters.rejects,
      versions: ev.length,
      added,
      removed,
      droppedPct: b && all > 0 ? (100 * b.droppedFrames) / all : 0,
      reservoirMb: st.reservoirBytes / 1048576,
      framesPerTile: st.framesPerTile,
      warning: st.reservoirWarning ?? null,
    };
  }
  return {
    budgetMs: 1000 / c.fps(),
    stages: [
      { label: 'read', key: 'read', ms: ms.readMs },
      {
        label: busy.length > 0 ? 'preprocess front' : 'preprocess',
        key: 'preprocess',
        ms: ms.preprocessMs,
      },
      { label: 'motion', key: 'motion', ms: ms.motionMs },
    ],
    busy:
      busy.length > 0
        ? [
            { label: 'frame + preprocess', key: 'front', ms: busy[0] },
            { label: 'motion', key: 'motion', ms: busy[1] },
            { label: 'back + trace', key: 'back', ms: busy[2] },
          ]
        : [],
    throughputFps: s.fps(),
    perFrame: [
      { label: 'discovery on', key: 'on', s: summarize(t.on) },
      { label: 'discovery off', key: 'off', s: summarize(t.off) },
      { label: 'trace solve, discovery on', key: 'solve-on', s: summarize(t.solveOn) },
      { label: 'trace solve, discovery off', key: 'solve-off', s: summarize(t.solveOff) },
    ],
    qc: [
      { label: 'trace solve with QC', key: 'solve-qc', s: summarize(t.solveQc), perFrame: true },
      {
        label: 'trace solve without QC',
        key: 'solve-noqc',
        s: summarize(t.solveNoQc),
        perFrame: true,
      },
      { label: 'QC snapshot', key: 'qc-build', s: summarize(t.qcBuildMs), perFrame: false },
    ],
    slow: [
      { label: 'per batch', key: 'batch', s: summarize(slow.batchMs) },
      { label: 'longest step per batch', key: 'step', s: summarize(slow.stepMs) },
    ],
    visits:
      st && (st.visitWorkers ?? 0) > 0
        ? {
            workers: st.visitWorkers,
            jobs: st.jobs,
            inFlight: st.jobsInFlight,
            ms: st.visitMs,
          }
        : null,
    counters,
  };
}

/** The shared log axis under a group of timing rows. */
function TimingAxis(): JSX.Element {
  return (
    <div class="cala-timing__row cala-timing__axis" aria-hidden="true">
      <div class="cala-timing__ticks">
        <For each={TIMING_TICKS}>
          {(v) => (
            <span
              class="cala-timing__tick"
              style={{ left: pct(rangePosition(v, TIMING_RANGE)!.t) }}
            >
              {v < 1 ? v : v.toLocaleString()}
            </span>
          )}
        </For>
      </div>
      <span class="cala-timing__unit">ms</span>
    </div>
  );
}

/** One row: a summary as a span from mean to max with a dot at p99, or a grey dash. */
function SummaryRow(p: {
  label: string;
  s: Summary;
  budget?: number;
  testid: string;
}): JSX.Element {
  const has = () => p.s.n > 0;
  return (
    <div class="cala-timing__row" data-testid={p.testid}>
      <span class="cala-timing__label">{p.label}</span>
      <RangeBar
        lo={has() ? p.s.mean : null}
        hi={has() ? p.s.max : null}
        mark={has() ? p.s.p99 : null}
        reference={p.budget}
        {...TIMING_RANGE}
        label={`${p.label}, mean to max, ms`}
        format={fmtMs}
      />
      <span class="cala-timing__fig num" title={has() ? `${p.s.n} batches` : undefined}>
        <Show when={has()} fallback={<span class="cala-dash">–</span>}>
          {fmtMs(p.s.mean)} · {fmtMs(p.s.p99)} · {fmtMs(p.s.max)}
        </Show>
      </span>
    </div>
  );
}

/** One row: a single per-frame figure as a dot on the shared axis. */
function ValueRow(p: { label: string; ms: number; budget?: number; testid: string }): JSX.Element {
  const has = () => Number.isFinite(p.ms) && p.ms > 0;
  return (
    <div class="cala-timing__row" data-testid={p.testid}>
      <span class="cala-timing__label">{p.label}</span>
      <RangeBar
        lo={has() ? p.ms : null}
        hi={has() ? p.ms : null}
        mark={has() ? p.ms : null}
        reference={p.budget}
        {...TIMING_RANGE}
        label={`${p.label}, ms per frame`}
        format={fmtMs}
      />
      <span class="cala-timing__fig num">
        <Show when={has()} fallback={<span class="cala-dash">–</span>}>
          {fmtMs(p.ms)}
        </Show>
      </span>
    </div>
  );
}

function GroupHead(p: { title: string; aside?: JSX.Element }): JSX.Element {
  return (
    <div class="cala-timing__head">
      <h3 class="cala-timing__title">{p.title}</h3>
      <Show when={p.aside}>
        <span class="cala-timing__aside num">{p.aside}</span>
      </Show>
    </div>
  );
}

/**
 * The Timing tab: where the time per frame goes, as rows on one fixed log axis with the
 * recording's real-time frame budget as a dashed line, then the slow loop's counters.
 * Everything is read at most at 2 Hz.
 */
export function TimingPanel(props: { store: PipelineStore; cells: CellStore }): JSX.Element {
  const snap = createSampled(
    () => readSnapshot(props.store, props.cells),
    () => `${props.store.status()}|${props.cells.status() ? 1 : 0}`,
    SAMPLE_MS,
  );
  const budget = () => snap().budgetMs;
  return (
    <div class="cala-timing" data-testid="timing-panel">
      <div class="cala-timing__intro">
        <Legend
          label="How the timing rows are drawn"
          items={[
            { label: 'mean to max', color: 'var(--mark-neutral)' },
            { label: 'p99', color: 'var(--ink-1)', mark: 'dot' },
            { label: 'frame budget', color: 'var(--ink-2)', mark: 'line', dashed: true },
          ]}
        />
        <HelpTip label="About the timing rows" testid="timing-help" popClass="cala-timing__help">
          <p>
            Every row is in milliseconds on one fixed log axis. Per-frame rows show the mean to the
            max over recent batches with a dot at the 99th percentile; the dashed line is the time
            one frame lasts at the recording's frame rate, so a stage right of it is slower than
            real time. Figures read mean · p99 · max. The pipeline rows are one figure each, the
            mean per frame, drawn as a dot.
          </p>
        </HelpTip>
      </div>

      <section class="cala-timing__group" data-testid="pipeline-stages">
        <GroupHead title="Pipeline per frame" />
        <For each={snap().stages}>
          {(r) => (
            <ValueRow
              label={r.label}
              ms={r.ms}
              budget={budget()}
              testid={`timing-stage-${r.key}`}
            />
          )}
        </For>
        <Show when={snap().busy.length > 0}>
          <GroupHead
            title="Pipelined stage busy per frame"
            aside={<>{snap().throughputFps.toFixed(1)} fps</>}
          />
          <For each={snap().busy}>
            {(r) => (
              <ValueRow
                label={r.label}
                ms={r.ms}
                budget={budget()}
                testid={`timing-busy-${r.key}`}
              />
            )}
          </For>
        </Show>
        <TimingAxis />
      </section>

      <section class="cala-timing__group" data-testid="fast-timing">
        <GroupHead title="Fast loop per frame" aside="mean · p99 · max" />
        <For each={snap().perFrame}>
          {(r) => (
            <SummaryRow label={r.label} s={r.s} budget={budget()} testid={`timing-${r.key}`} />
          )}
        </For>
        <TimingAxis />
      </section>

      <section class="cala-timing__group" data-testid="qc-timing">
        <GroupHead title="Online QC" aside="mean · p99 · max" />
        <For each={snap().qc}>
          {(r) => (
            <SummaryRow
              label={r.label}
              s={r.s}
              budget={r.perFrame ? budget() : undefined}
              testid={`timing-${r.key}`}
            />
          )}
        </For>
        <TimingAxis />
      </section>

      <section class="cala-timing__group" data-testid="slow-timing">
        <GroupHead title="Slow loop" aside="mean · p99 · max" />
        <For each={snap().slow}>
          {(r) => <SummaryRow label={r.label} s={r.s} testid={`timing-slow-${r.key}`} />}
        </For>
        <Show when={snap().visits}>
          {(v) => (
            <div class="cala-timing__row" data-testid="visit-timing">
              <span class="cala-timing__label">tile visit (latest)</span>
              <RangeBar
                lo={v().ms}
                hi={v().ms}
                mark={v().ms}
                {...TIMING_RANGE}
                label="Latest tile visit, ms"
                format={fmtMs}
              />
              <span class="cala-timing__fig num">{fmtMs(v().ms)}</span>
            </div>
          )}
        </Show>
        <TimingAxis />
        <Show when={snap().visits}>
          {(v) => (
            <p class="cala-timing__facts num" data-testid="visit-facts">
              {v().workers} visit workers · {v().jobs.toLocaleString()} visits · {v().inFlight} out
              now
            </p>
          )}
        </Show>
      </section>

      <SlowCounters counters={snap().counters} />
    </div>
  );
}

/** The slow loop's counts as label and figure pairs. */
function countRows(
  k: NonNullable<TimingSnapshot['counters']>,
): { label: string; value: JSX.Element }[] {
  const n = (v: number) => v.toLocaleString();
  return [
    { label: 'working set', value: n(k.cells) },
    { label: 'adds', value: n(k.adds) },
    { label: 'merges', value: n(k.merges) },
    { label: 'refines', value: n(k.refines) },
    { label: 'rejects', value: n(k.rejects) },
    {
      label: 'versions',
      value: (
        <>
          {n(k.versions)}{' '}
          <span class="unit">
            +{n(k.added)} / −{n(k.removed)}
          </span>
        </>
      ),
    },
    {
      label: 'reservoir',
      value: (
        <>
          {k.reservoirMb.toFixed(0)} <span class="unit">MB</span>
        </>
      ),
    },
    ...(k.framesPerTile > 0 ? [{ label: 'frames per tile', value: n(k.framesPerTile) }] : []),
  ];
}

/** The slow loop's running counts, or the line saying it has not started. */
function SlowCounters(p: { counters: TimingSnapshot['counters'] }): JSX.Element {
  return (
    <section class="cala-timing__group" data-testid="cells-counters">
      <GroupHead title="Slow loop counts" />
      <Show
        when={p.counters}
        fallback={<p class="cala-muted">The slow loop starts after frame 50.</p>}
      >
        {(k) => (
          <>
            <dl class="cala-timing__counts num">
              <For each={countRows(k())}>
                {(r) => (
                  <div>
                    <dt>{r.label}</dt>
                    <dd>{r.value}</dd>
                  </div>
                )}
              </For>
            </dl>
            <div class="cala-timing__row" data-testid="cells-dropped">
              <span class="cala-timing__label">frames dropped</span>
              <Meter
                value={k().droppedPct}
                min={0}
                max={100}
                label="Frames the slow loop dropped"
                format={(v) => `${v.toFixed(0)} %`}
                size="sm"
              />
              <span class="cala-timing__fig num">
                {k().droppedPct.toFixed(0)} <span class="unit">%</span>
              </span>
            </div>
            <Show when={k().warning}>
              {(w) => <StatusNote testid="reservoir-warning">{w()}</StatusNote>}
            </Show>
          </>
        )}
      </Show>
    </section>
  );
}
