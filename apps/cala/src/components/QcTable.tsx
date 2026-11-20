import { createMemo, createSignal, For, Index, Show, type JSX } from 'solid-js';
import type { CellStore } from '../lib/cell-store.ts';
import {
  FLAG_CORRELATED_PAIR,
  FLAG_LIKELY_DUPLICATE,
  FLAG_LOW_SNR,
  FLAG_UNMEASURED,
  followsMotion,
  MOTION_R2_FLAG,
  sortRows,
  verdict,
  type CellQcRow,
  type SortKey,
} from '../lib/qc.ts';

interface Column {
  key: SortKey;
  label: string;
  title: string;
  /** First click sorts descending (largest first). */
  desc?: boolean;
}

const COLUMNS: Column[] = [
  { key: 'id', label: 'Cell', title: 'Cell id' },
  {
    key: 'flagged',
    label: 'QC',
    title: 'Verdict: failing cells first, then correlated pairs, passing, not measured',
  },
  { key: 'peakSnr', label: 'SNR', title: 'Peak SNR in noise units (pass needs >= 5)' },
  {
    key: 'projR',
    label: 'proj r',
    title:
      'Trace fidelity: trace vs its own footprint projection (low = neighbours take its light)',
  },
  {
    key: 'vif',
    label: 'vif',
    title: 'Variance inflation from overlapping footprints (1 = none): expected crosstalk',
    desc: true,
  },
  {
    key: 'maxNeighbourR',
    label: 'nb r',
    title: 'Largest trace correlation with an overlapping neighbour (> 0.8 = split/duplicate flag)',
    desc: true,
  },
  {
    key: 'fpError',
    label: 'fp err',
    title: 'Footprint mismatch (relative; no threshold separates good from bad)',
    desc: true,
  },
  {
    key: 'motionR2',
    label: 'motion R²',
    title: `Cross-validated R² of the trace on a quadratic of the frame's rigid shift. Above ${MOTION_R2_FLAG} the trace follows motion: sensor-gain shimmer or a motion artifact, not calcium. Flag only, it does not change pass/fail. Negative = no relation.`,
    desc: true,
  },
  { key: 'eventRate', label: 'ev/min', title: 'Events per minute (descriptive)', desc: true },
  { key: 'ageFrames', label: 'age', title: 'Minutes since the cell entered the library' },
];

const num = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '');

function badge(r: CellQcRow): { cls: string; text: string } {
  if (r.flags & FLAG_UNMEASURED) return { cls: 'pending', text: '...' };
  if (r.flags & FLAG_LIKELY_DUPLICATE) return { cls: 'fail', text: 'dup?' };
  if (r.flags & FLAG_LOW_SNR) return { cls: 'fail', text: 'low SNR' };
  if (r.flags & FLAG_CORRELATED_PAIR) return { cls: 'warn', text: 'pair' };
  return { cls: 'pass', text: 'pass' };
}

/** The QC table's sort and filter, kept by its owner so they outlive the table (a hidden tab). */
export function createQcTableState() {
  const [key, setKey] = createSignal<SortKey>('flagged');
  const [dir, setDir] = createSignal<1 | -1>(1);
  const [flaggedOnly, setFlaggedOnly] = createSignal(false);
  return { key, setKey, dir, setDir, flaggedOnly, setFlaggedOnly };
}

export type QcTableState = ReturnType<typeof createQcTableState>;

/**
 * Every cell with its QC metrics, sortable; flagged cells first by default.
 * Clicking a row selects the cell (as clicking its outline does).
 */
export function QcTable(props: { cells: CellStore; state?: QcTableState }): JSX.Element {
  // The owner's state, or a table of its own (fixed per mount).
  const { key, setKey, dir, setDir, flaggedOnly, setFlaggedOnly } =
    // eslint-disable-next-line solid/reactivity
    props.state ?? createQcTableState();
  const qc = () => props.cells.qc();
  const est = () => props.cells.established();
  const fps = () => props.cells.fps();

  const rows = createMemo(() => {
    const snap = qc();
    if (!snap) return [];
    const all = flaggedOnly()
      ? snap.rows.filter((r) => !r.pass && !(r.flags & FLAG_UNMEASURED))
      : snap.rows;
    return sortRows(all, key(), dir());
  });

  const counts = createMemo(() => {
    const snap = qc();
    const c = { all: 0, pass: 0, lowSnr: 0, dup: 0, pending: 0 };
    for (const r of snap?.rows ?? []) {
      c.all++;
      if (r.flags & FLAG_UNMEASURED) c.pending++;
      else if (r.pass) c.pass++;
      if (r.flags & FLAG_LOW_SNR) c.lowSnr++;
      if (r.flags & FLAG_LIKELY_DUPLICATE) c.dup++;
    }
    return c;
  });

  function sortBy(c: Column): void {
    if (key() === c.key) setDir((d) => (d === 1 ? -1 : 1));
    else {
      setKey(c.key);
      setDir(c.desc ? -1 : 1);
    }
  }

  return (
    <div class="cala-qc-table" data-testid="qc-table">
      <div class="cala-trace-head">
        <span class="cala-muted" data-testid="qc-counts">
          <Show when={qc()} fallback="QC starts once the fast loop solves cells.">
            {counts().all} cells: {counts().pass} pass, {counts().lowSnr} low SNR, {counts().dup}{' '}
            possible duplicates, {counts().pending} not measured yet
          </Show>
        </span>
        <label class="cala-check">
          <input
            type="checkbox"
            checked={flaggedOnly()}
            onChange={(e) => setFlaggedOnly(e.currentTarget.checked)}
          />
          failing only
        </label>
      </div>
      <div class="cala-qc-table__scroll">
        <table>
          <thead>
            <tr>
              <For each={COLUMNS}>
                {(c) => (
                  <th
                    title={c.title}
                    aria-sort={
                      key() === c.key ? (dir() === 1 ? 'ascending' : 'descending') : undefined
                    }
                  >
                    <button type="button" onClick={() => sortBy(c)}>
                      {c.label}
                      <Show when={key() === c.key}>{dir() === 1 ? ' ▲' : ' ▼'}</Show>
                    </button>
                  </th>
                )}
              </For>
              <th title="Slow-loop evidence status">status</th>
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
                >
                  <td>#{r().id}</td>
                  <td>
                    <span class={`cala-qc-badge cala-qc-badge--${badge(r()).cls}`}>
                      {badge(r()).text}
                    </span>
                  </td>
                  <td>{num(r().peakSnr, 1)}</td>
                  <td>{num(r().projR)}</td>
                  <td>{num(r().vif)}</td>
                  <td>
                    {num(r().maxNeighbourR)}
                    <Show when={r().maxNeighbourId >= 0}>
                      <button
                        type="button"
                        class="cala-link"
                        onClick={(e) => {
                          e.stopPropagation();
                          props.cells.select(r().maxNeighbourId);
                        }}
                      >
                        {' '}
                        #{r().maxNeighbourId}
                      </button>
                    </Show>
                  </td>
                  <td>{num(r().fpError)}</td>
                  <td data-testid="qc-motion-r2">
                    {num(r().motionR2)}
                    <Show when={followsMotion(r())}>
                      <span
                        class="cala-qc-badge cala-qc-badge--warn"
                        title={`Trace follows motion (motion R² > ${MOTION_R2_FLAG}): sensor-gain shimmer or motion artifact. Flag only; pass/fail is unchanged.`}
                        data-testid="qc-motion-flag"
                      >
                        {' '}
                        motion
                      </span>
                    </Show>
                  </td>
                  <td>{num(r().eventRate, 1)}</td>
                  <td>{num(r().ageFrames / fps() / 60, 1)}</td>
                  <td class="cala-muted">
                    {est().has(r().id) ? (est().get(r().id) ? 'established' : 'probation') : ''}
                  </td>
                </tr>
              )}
            </Index>
          </tbody>
        </table>
      </div>
    </div>
  );
}
