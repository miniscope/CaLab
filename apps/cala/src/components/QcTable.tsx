import { createMemo, createSignal, For, Index, Show, type JSX } from 'solid-js';
import { Meter, SegmentedBar } from '@calab/ui';
import type { CellStore } from '../lib/cell-store.ts';
import { followsMotion, sortRows, verdict, type CellQcRow, type SortKey } from '../lib/qc.ts';
import {
  filterRows,
  metricText,
  QC_STATUS_LABEL,
  qcCounts,
  qcMedian,
  qcMetric,
  qcReason,
  qcStatus,
  thresholdTitle,
  type QcFilter,
  type QcMetricKey,
  type QcStatus,
} from '../lib/qc-view.ts';
import { QC_STATUS_COLOR, QcDot } from './QcDot.tsx';
import { QcBarKey } from './QcBarKey.tsx';
import { STILL_MOVING_HELP, STILL_MOVING_SCALE } from '../lib/settle.ts';

/** Columns the picker can show or hide; the cell and its SNR are always shown. */
export type QcColumnKey =
  | 'reason'
  | 'maxNeighbourR'
  | 'projR'
  | 'motionR2'
  | 'vif'
  | 'fpError'
  | 'eventRate'
  | 'ageFrames'
  | 'moving'
  | 'status';

interface Column {
  key: QcColumnKey;
  label: string;
  title: string;
  /** What the header sorts by; absent: the column does not sort. */
  sort?: SortKey | 'moving';
  /** First click sorts descending (largest first). */
  desc?: boolean;
  /** A figure column: right-aligned tabular figures. */
  num?: boolean;
}

const metricTitle = (k: QcMetricKey) => qcMetric(k).help;

/** Every optional column, in table order. */
const COLUMNS: readonly Column[] = [
  {
    key: 'reason',
    label: 'Flag',
    title: 'Why a cell is flagged; sorts failing cells first, then pairs, passing, not measured',
    sort: 'flagged',
  },
  {
    key: 'maxNeighbourR',
    label: 'nb r',
    title: metricTitle('maxNeighbourR'),
    sort: 'maxNeighbourR',
    desc: true,
    num: true,
  },
  { key: 'projR', label: 'proj r', title: metricTitle('projR'), sort: 'projR', num: true },
  {
    key: 'motionR2',
    label: 'motion R²',
    title: metricTitle('motionR2'),
    sort: 'motionR2',
    desc: true,
    num: true,
  },
  { key: 'vif', label: 'vif', title: metricTitle('vif'), sort: 'vif', desc: true, num: true },
  {
    key: 'fpError',
    label: 'fp err',
    title: metricTitle('fpError'),
    sort: 'fpError',
    desc: true,
    num: true,
  },
  {
    key: 'eventRate',
    label: 'ev/min',
    title: metricTitle('eventRate'),
    sort: 'eventRate',
    desc: true,
    num: true,
  },
  {
    key: 'ageFrames',
    label: 'age',
    title: 'Minutes since the cell entered the library',
    sort: 'ageFrames',
    num: true,
  },
  {
    key: 'moving',
    label: 'moving',
    title: STILL_MOVING_HELP,
    sort: 'moving',
    desc: true,
    num: true,
  },
  { key: 'status', label: 'slow loop', title: 'Slow-loop evidence status' },
];

/** The four key columns shown until the user picks others. */
export const DEFAULT_QC_COLUMNS: readonly QcColumnKey[] = [
  'reason',
  'maxNeighbourR',
  'projR',
  'motionR2',
];

const num = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '');

/** The "still moving" hint, clipped at the top of its fixed scale (blank: none yet). */
export function movingText(v: number | undefined): string {
  if (v === undefined || Number.isNaN(v)) return '';
  return v > STILL_MOVING_SCALE.hi ? `>${STILL_MOVING_SCALE.hi}` : v.toFixed(1);
}

const STATUSES: readonly QcStatus[] = ['pass', 'fail', 'unmeasured'];

/** The QC table's sort, filter and columns, kept by its owner so they outlive the table (a hidden tab). */
export function createQcTableState() {
  const [key, setKey] = createSignal<SortKey | 'moving'>('flagged');
  const [dir, setDir] = createSignal<1 | -1>(1);
  const [filter, setFilter] = createSignal<QcFilter>('all');
  const [columns, setColumns] = createSignal<readonly QcColumnKey[]>(DEFAULT_QC_COLUMNS);
  return { key, setKey, dir, setDir, filter, setFilter, columns, setColumns };
}

export type QcTableState = ReturnType<typeof createQcTableState>;

/**
 * The QC summary (a segmented bar of pass / fail / not measured whose buttons
 * filter the table) above every cell with its QC metrics, sortable; flagged
 * cells first by default. Clicking a row selects the cell (as clicking its
 * outline does). Reads only `qc()`, a snapshot about once a second.
 */
export function QcTable(props: { cells: CellStore; state?: QcTableState }): JSX.Element {
  // The owner's state, or a table of its own (fixed per mount).
  const { key, setKey, dir, setDir, filter, setFilter, columns, setColumns } =
    // eslint-disable-next-line solid/reactivity
    props.state ?? createQcTableState();
  const qc = () => props.cells.qc();
  const est = () => props.cells.established();
  const fps = () => props.cells.fps();
  const shown = createMemo(() => COLUMNS.filter((c) => columns().includes(c.key)));
  const snr = qcMetric('peakSnr');
  // One median per QC snapshot, shared by every row's bar.
  const snrMedian = createMemo(() => qcMedian(qc()?.rows ?? [], 'peakSnr'));

  const rows = createMemo(() => {
    const snap = qc();
    if (!snap) return [];
    const all = filterRows(snap.rows, filter());
    const k = key();
    if (k !== 'moving') return sortRows(all, k, dir());
    // The hint is the slow loop's, not a QC metric: cells without one sort last.
    const mov = props.cells.stillMoving();
    const v = (id: number) => mov.get(id) ?? Number.NaN;
    return sortRows(all, 'id').sort((a, b) => {
      const x = v(a.id);
      const y = v(b.id);
      if (Number.isNaN(x) || Number.isNaN(y))
        return Number.isNaN(x) === Number.isNaN(y) ? 0 : Number.isNaN(x) ? 1 : -1;
      return dir() * (x - y);
    });
  });

  const counts = createMemo(() => qcCounts(qc()?.rows ?? []));

  function sortBy(s: SortKey | 'moving', desc?: boolean): void {
    if (key() === s) setDir((d) => (d === 1 ? -1 : 1));
    else {
      setKey(s);
      setDir(desc ? -1 : 1);
    }
  }
  /** A status filter toggles: picking the active one again shows every cell. */
  const pick = (f: QcStatus) => setFilter(filter() === f ? 'all' : f);
  const toggleColumn = (k: QcColumnKey, on: boolean) =>
    setColumns(COLUMNS.map((c) => c.key).filter((c) => (c === k ? on : columns().includes(c))));

  const SortHead = (p: {
    label: string;
    title: string;
    sort: SortKey | 'moving';
    desc?: boolean;
    num?: boolean;
    children?: JSX.Element;
  }) => (
    <th
      title={p.title}
      classList={{ num: p.num }}
      aria-sort={key() === p.sort ? (dir() === 1 ? 'ascending' : 'descending') : undefined}
    >
      <button type="button" onClick={() => sortBy(p.sort, p.desc)}>
        {p.label}
        <Show when={key() === p.sort}>{dir() === 1 ? ' ▲' : ' ▼'}</Show>
      </button>
      {p.children}
    </th>
  );

  const cell = (c: Column, r: CellQcRow): JSX.Element => {
    switch (c.key) {
      case 'reason':
        return <span class="cala-muted">{qcReason(r)}</span>;
      case 'maxNeighbourR':
        return (
          <>
            {num(r.maxNeighbourR)}
            <Show when={r.maxNeighbourId >= 0}>
              <button
                type="button"
                class="cala-link"
                title={`Select its neighbour #${r.maxNeighbourId}`}
                onClick={(e) => {
                  e.stopPropagation();
                  props.cells.select(r.maxNeighbourId);
                }}
              >
                #{r.maxNeighbourId}
              </button>
            </Show>
          </>
        );
      case 'motionR2':
        return (
          <span
            data-testid="qc-motion-r2"
            data-follows-motion={followsMotion(r) ? 'true' : undefined}
          >
            {num(r.motionR2)}
          </span>
        );
      case 'projR':
        return num(r.projR);
      case 'vif':
        return num(r.vif);
      case 'fpError':
        return num(r.fpError);
      case 'eventRate':
        return num(r.eventRate, 1);
      case 'ageFrames':
        return num(r.ageFrames / fps() / 60, 1);
      case 'moving':
        return (
          <span data-testid="qc-moving">{movingText(props.cells.stillMovingRatio(r.id))}</span>
        );
      case 'status':
        return (
          <span class="cala-muted">
            {est().has(r.id) ? (est().get(r.id) ? 'established' : 'probation') : ''}
          </span>
        );
    }
  };

  return (
    <div class="cala-qc-table" data-testid="qc-table">
      <div class="cala-qc-summary" data-testid="qc-counts">
        <Show
          when={qc() && counts().all > 0}
          fallback={
            <span class="cala-muted">
              <Show when={qc()} fallback="QC starts once the fast loop solves cells.">
                No cells yet.
              </Show>
            </span>
          }
        >
          <SegmentedBar
            label="QC"
            total={counts().all}
            parts={STATUSES.map((s) => ({
              id: s,
              label: QC_STATUS_LABEL[s],
              value: counts()[s],
              color: QC_STATUS_COLOR[s],
            }))}
            active={filter() === 'all' ? undefined : filter()}
            onPartClick={(id) => pick(id as QcStatus)}
            testid="qc-summary-bar"
          />
          <div class="cala-qc-summary__row" role="group" aria-label="Show cells">
            <button
              type="button"
              class="cala-qc-filter"
              aria-pressed={filter() === 'all'}
              onClick={() => setFilter('all')}
              data-testid="qc-filter-all"
            >
              All <span class="num">{counts().all}</span>
            </button>
            <For each={STATUSES}>
              {(s) => (
                <button
                  type="button"
                  class="cala-qc-filter"
                  aria-pressed={filter() === s}
                  onClick={() => pick(s)}
                  data-testid={`qc-filter-${s}`}
                >
                  <QcDot status={s} />
                  {QC_STATUS_LABEL[s]} <span class="num">{counts()[s]}</span>
                </button>
              )}
            </For>
            <details class="cala-qc-columns" data-testid="qc-columns">
              <summary title="Choose the table's columns">Columns</summary>
              <div class="cala-qc-columns__menu">
                <For each={COLUMNS}>
                  {(c) => (
                    <label class="cala-check" title={c.title}>
                      <input
                        type="checkbox"
                        checked={columns().includes(c.key)}
                        onChange={(e) => toggleColumn(c.key, e.currentTarget.checked)}
                        data-testid={`qc-column-${c.key}`}
                      />
                      {c.label}
                    </label>
                  )}
                </For>
              </div>
            </details>
          </div>
        </Show>
      </div>
      <div class="cala-qc-table__scroll">
        <table>
          <thead>
            <tr>
              <SortHead label="Cell" title="Cell id, with its QC status" sort="id" />
              <SortHead label="SNR" title={snr.help} sort="peakSnr" desc num>
                <QcBarKey threshold={snr.thresholdText} median={snrMedian()} digits={snr.digits} />
              </SortHead>
              <For each={shown()}>
                {(c) => (
                  <Show
                    when={c.sort}
                    fallback={
                      <th title={c.title} classList={{ num: c.num }}>
                        <span class="cala-qc-table__th">{c.label}</span>
                      </th>
                    }
                  >
                    {(s) => (
                      <SortHead
                        label={c.label}
                        title={c.title}
                        sort={s()}
                        desc={c.desc}
                        num={c.num}
                      />
                    )}
                  </Show>
                )}
              </For>
            </tr>
          </thead>
          <tbody>
            <Index each={rows()}>
              {(r) => (
                <tr
                  classList={{ 'cala-qc-row--selected': props.cells.selected() === r().id }}
                  onClick={() => props.cells.select(r().id)}
                  title={verdict(r()).label}
                  data-testid="qc-row"
                  data-status={qcStatus(r())}
                >
                  <td class="cala-qc-table__id">
                    <QcDot status={qcStatus(r())} title={verdict(r()).label} />#{r().id}
                  </td>
                  <td class="num">
                    <div class="cala-qc-table__snr">
                      <Meter
                        value={r().peakSnr}
                        min={snr.range!.min}
                        scale={snr.range!.scale}
                        max={snr.range!.max}
                        target={snr.threshold}
                        targetTitle={thresholdTitle(snr)}
                        median={snrMedian()?.value}
                        medianTitle={snrMedian()?.title}
                        label={`Cell ${r().id} peak SNR`}
                        format={(v) => v.toFixed(1)}
                        size="sm"
                      />
                      <span>{metricText(snr, r().peakSnr) ?? '–'}</span>
                    </div>
                  </td>
                  <For each={shown()}>
                    {(c) => <td classList={{ num: c.num }}>{cell(c, r())}</td>}
                  </For>
                </tr>
              )}
            </Index>
          </tbody>
        </table>
      </div>
    </div>
  );
}
