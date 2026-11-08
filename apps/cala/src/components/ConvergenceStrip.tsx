import { createMemo, For, type JSX } from 'solid-js';
import { DashboardPanel } from '@calab/ui';
import { OKABE_ITO } from '@calab/ui/chart';
import type { CellStore } from '../lib/cell-store.ts';
import type { ConvergencePoint, ConvergenceState } from '../lib/qc.ts';

const W = 150;
const H = 30;

interface Line {
  values: number[];
  color: string;
  dash?: string;
}

/** Path of `values` against `x` scaled into the sparkline box; gaps at NaN. */
function path(x: number[], values: number[], x1: number, lo: number, hi: number): string {
  let d = '';
  let pen = false;
  const span = hi > lo ? hi - lo : 1;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) {
      pen = false;
      continue;
    }
    const px = x1 > 0 ? (x[i] / x1) * W : 0;
    const py = H - 1 - Math.min(1, (v - lo) / span) * (H - 2);
    d += `${pen ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`;
    pen = true;
  }
  return d;
}

/** A small multiple: title, current value, and the line(s) against minutes read. */
function Spark(props: {
  title: string;
  value: JSX.Element;
  hint: string;
  x: number[];
  lines: Line[];
  /** Fixed y range (else the data's, from 0). */
  range?: [number, number];
  testid: string;
}): JSX.Element {
  const box = createMemo(() => {
    const x1 = props.x.at(-1) ?? 0;
    let lo = props.range?.[0] ?? 0;
    let hi = props.range?.[1] ?? -Infinity;
    if (!props.range) {
      // From 0 (or the lowest value) to the 98th percentile: one early spike
      // (rates over a short history) must not flatten the rest.
      const v = props.lines.flatMap((l) => l.values.filter(Number.isFinite)).sort((a, b) => a - b);
      if (v.length > 0) {
        lo = Math.min(0, v[0]);
        hi = v[Math.floor(0.98 * (v.length - 1))];
      }
      if (!Number.isFinite(hi) || hi <= lo) hi = lo + 1;
    }
    return { x1, lo, hi };
  });
  return (
    <div class="cala-spark" title={props.hint} data-testid={props.testid}>
      <div class="cala-spark__head">
        <span class="cala-spark__title">{props.title}</span>
        <span class="cala-spark__value">{props.value}</span>
      </div>
      <svg class="cala-spark__plot" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <For each={props.lines}>
          {(l) => (
            <path
              d={path(props.x, l.values, box().x1, box().lo, box().hi)}
              fill="none"
              stroke={l.color}
              stroke-width="1.4"
              stroke-dasharray={l.dash}
              vector-effect="non-scaling-stroke"
            />
          )}
        </For>
      </svg>
    </div>
  );
}

const STATE_LABEL: Record<ConvergenceState, string> = {
  waiting: 'Waiting for cells',
  discovering: 'Discovering cells',
  settling: 'Settling',
  converged: 'Converged',
};

const EDIT_COLORS = {
  adds: OKABE_ITO.bluishGreen,
  merges: OKABE_ITO.blue,
  splits: OKABE_ITO.orange,
  deletes: OKABE_ITO.vermillion,
} as const;

const EDIT_KEYS = ['adds', 'merges', 'splits', 'deletes'] as const;

const fmt = (v: number | undefined, digits = 2) =>
  v === undefined || !Number.isFinite(v) ? 'n/a' : v.toFixed(digits);

/**
 * Always-visible convergence strip: where the run stands (status line) and
 * the curves it is read from, against minutes of recording read.
 */
export function ConvergenceStrip(props: { cells: CellStore }): JSX.Element {
  const pts = createMemo(() => props.cells.convergenceHistory().slice());
  const x = () => pts().map((p) => p.minutes);
  const col = (k: keyof Omit<ConvergencePoint, 'edits'>) => pts().map((p) => p[k]);
  const edit = (k: keyof ConvergencePoint['edits']) => pts().map((p) => p.edits[k]);
  const last = () => pts().at(-1);
  const st = () => props.cells.convergence();
  const minutes = () => last()?.minutes ?? 0;
  return (
    <DashboardPanel id="convergence" variant="data" class="cala-convergence">
      <div class="cala-convergence__status" data-testid="convergence-status">
        <span class={`cala-conv-chip cala-conv-chip--${st().state}`}>
          {STATE_LABEL[st().state]}
        </span>
        <span class="cala-muted cala-convergence__reason">{st().reason}</span>
        <span class="cala-muted cala-convergence__axis">
          vs minutes read: 0 to {minutes().toFixed(1)}
        </span>
      </div>
      <div class="cala-convergence__plots">
        <Spark
          title="Cells"
          value={fmt(last()?.cells, 0)}
          hint="Cells in the library the fast loop solves."
          x={x()}
          lines={[{ values: col('cells'), color: OKABE_ITO.blue }]}
          testid="spark-cells"
        />
        <Spark
          title="Edits / min"
          value={
            <For each={EDIT_KEYS}>
              {(k) => (
                <span style={{ color: EDIT_COLORS[k] }} title={k}>
                  {' '}
                  {k[0]}
                  {fmt(last()?.edits[k], 0)}
                </span>
              )}
            </For>
          }
          hint="Slow-loop edits per minute of recording: a = adds (green), m = merges (blue), s = splits (orange), d = deletes (red). Churn should fall towards a floor."
          x={x()}
          lines={EDIT_KEYS.map((k) => ({
            values: edit(k),
            color: EDIT_COLORS[k],
          }))}
          testid="spark-edits"
        />
        <Spark
          title="Explained"
          value={fmt(last()?.explained)}
          hint="Share of the signal variance (above noise) the model explains. Rises to an asymptote as cells are found (tracked true recall in validation)."
          x={x()}
          lines={[{ values: col('explained'), color: OKABE_ITO.bluishGreen }]}
          range={[0, 1]}
          testid="spark-explained"
        />
        <Spark
          title="Residual excess"
          value={fmt(last()?.residualExcess)}
          hint="Residual variance above noise, averaged over the field of view. Falls to an asymptote as the model explains more."
          x={x()}
          lines={[{ values: col('residualExcess'), color: OKABE_ITO.vermillion }]}
          testid="spark-residual"
        />
        <Spark
          title="Median SNR"
          value={fmt(last()?.snrMedian, 1)}
          hint="Median peak SNR of measured cells, and the share passing QC (dashed, x20). Context only: these did not track recall in validation and do not feed the status."
          x={x()}
          lines={[
            { values: col('snrMedian'), color: OKABE_ITO.reddishPurple },
            {
              values: col('passFrac').map((v) => 20 * v),
              color: OKABE_ITO.reddishPurple,
              dash: '3 2',
            },
          ]}
          range={[0, 20]}
          testid="spark-snr"
        />
      </div>
    </DashboardPanel>
  );
}
