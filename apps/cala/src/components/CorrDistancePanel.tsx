/**
 * The Correlation tab (docs/stages.md, "Correlation vs distance"): median
 * pairwise trace correlation against centre distance, a check for incomplete
 * demixing of neighbouring cells. Computed once on demand (button), in a
 * worker, from the traces and footprints the store holds; it never runs with
 * the pipeline. The y axis is fixed at -0.1 to 0.5 and only grows, in steps of
 * 0.1, when a bin's quartile falls outside it.
 */
import { createEffect, createMemo, createSignal, For, Show, type JSX } from 'solid-js';
import { HelpTip, Legend, StatusNote } from '@calab/ui';
import { OKABE_ITO } from '@calab/ui/palette';
import type { CellStore } from '../lib/cell-store.ts';
import { corrRequest, runCorrDistance } from '../lib/corr-distance-client.ts';
import { SCATTER_X_MAX, selectScatter, type CorrDistanceResult } from '../lib/corr-distance.ts';
import { errMsg } from '../lib/errors.ts';

const W = 360;
const H = 210;
const PAD_L = 38;
const PAD_R = 8;
const PAD_T = 10;
const PAD_B = 34;
/** Median line, IQR bars and bin dots. */
const SERIES = OKABE_ITO.blue;
/** The far-pairs reference line. */
const FAR = OKABE_ITO.vermillion;
/** The y range before any data: -0.1 to 0.5. */
const Y_DEFAULT: [number, number] = [-0.1, 0.5];

/** The y range: -0.1 to 0.5, widened to the next 0.1 only when the data needs it. */
export function corrYRange(res: Pick<CorrDistanceResult, 'bins' | 'farMedian'>): [number, number] {
  let [lo, hi] = Y_DEFAULT;
  for (const b of res.bins) {
    if (b.q25 !== null) lo = Math.min(lo, Math.floor(b.q25 * 10 - 1e-9) / 10);
    if (b.q75 !== null) hi = Math.max(hi, Math.ceil(b.q75 * 10 - 1e-9) / 10);
  }
  return [Math.round(lo * 10) / 10, Math.round(hi * 10) / 10];
}

/** Pixel position of an x value (soma diameters, clamped to the axis end). */
const xv = (d: number) =>
  PAD_L + ((W - PAD_L - PAD_R) * Math.min(d, SCATTER_X_MAX)) / SCATTER_X_MAX;

/** Pixel position of an r value on the y range. */
function yv(v: number, [lo, hi]: [number, number]): number {
  return PAD_T + (H - PAD_T - PAD_B) * (1 - (v - lo) / (hi - lo));
}

/** The plot's grid, ticks and axis titles on a y range (no data). */
function CorrAxes(props: { range: [number, number]; unit: string }): JSX.Element {
  const xTicks = Array.from({ length: SCATTER_X_MAX + 1 }, (_, i) => i);
  const yTicks = () => {
    const [lo, hi] = props.range;
    const out: number[] = [];
    for (let v = lo; v <= hi + 1e-9; v += 0.1) out.push(Math.round(v * 10) / 10);
    return out;
  };
  return (
    <>
      <For each={xTicks}>
        {(v) => (
          <>
            <line class="cala-corr__grid" x1={xv(v)} x2={xv(v)} y1={PAD_T} y2={H - PAD_B} />
            <text
              class="cala-corr__tick"
              x={xv(v)}
              y={H - PAD_B + 12}
              text-anchor="middle"
              data-testid="corr-x-tick"
            >
              {v === SCATTER_X_MAX ? `${v}+` : v}
            </text>
          </>
        )}
      </For>
      <For each={yTicks()}>
        {(v) => (
          <>
            <line
              class={v === 0 ? 'cala-corr__zero' : 'cala-corr__grid'}
              x1={PAD_L}
              x2={W - PAD_R}
              y1={yv(v, props.range)}
              y2={yv(v, props.range)}
            />
            <text
              class="cala-corr__tick"
              x={PAD_L - 4}
              y={yv(v, props.range) + 3}
              text-anchor="end"
            >
              {v.toFixed(1)}
            </text>
          </>
        )}
      </For>
      <text class="cala-corr__tick" x={(PAD_L + W - PAD_R) / 2} y={H - 4} text-anchor="middle">
        centre distance ({props.unit})
      </text>
      <text
        class="cala-corr__tick"
        transform={`translate(9 ${(PAD_T + H - PAD_B) / 2}) rotate(-90)`}
        text-anchor="middle"
      >
        pairwise r (high-passed)
      </text>
    </>
  );
}

/**
 * The plot's axes before Compute: the default ranges drawn faint, with what it takes to fill
 * them, so the tab shows what it will measure.
 */
export function CorrGhost(props: { message: string }): JSX.Element {
  return (
    <figure class="cala-corr__plot cala-corr__plot--ghost" data-testid="corr-ghost">
      <svg class="cala-corr__svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={props.message}>
        <g class="cala-corr__ghost-axes">
          <CorrAxes range={Y_DEFAULT} unit="soma diameters" />
        </g>
        <text
          class="cala-corr__ghost-text"
          x={(PAD_L + W - PAD_R) / 2}
          y={(PAD_T + H - PAD_B) / 2}
          text-anchor="middle"
          dominant-baseline="middle"
        >
          {props.message}
        </text>
      </svg>
    </figure>
  );
}

export function CorrDistancePlot(props: { result: CorrDistanceResult }): JSX.Element {
  const range = () => corrYRange(props.result);
  const x = (i: number) => xv(props.result.bins[i].medianDist ?? 0);
  const y = (v: number) => yv(v, range());
  const sel = createMemo(() => selectScatter(props.result, SCATTER_X_MAX, range()));
  let canvas: HTMLCanvasElement | undefined;
  createEffect(() => {
    const s = sel();
    const res = props.result;
    const [lo, hi] = range();
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const scale = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    canvas.width = W * scale;
    canvas.height = H * scale;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, W, H);
    // The pair dots take the canvas's CSS colour (the neutral mark token).
    ctx.fillStyle = getComputedStyle(canvas).color;
    ctx.globalAlpha = 0.22;
    const px = (W - PAD_L - PAD_R) / SCATTER_X_MAX;
    const py = (H - PAD_T - PAD_B) / (hi - lo);
    for (let i = 0; i < s.idx.length; i++) {
      const k = s.idx[i];
      ctx.fillRect(
        PAD_L + res.pairDist[k] * px - 0.9,
        PAD_T + (hi - res.pairR[k]) * py - 0.9,
        1.8,
        1.8,
      );
    }
  });
  // A bin whose median distance lies beyond the x extent is not drawn (the far line covers it).
  const shown = (i: number) =>
    props.result.bins[i].median !== null && (props.result.bins[i].medianDist ?? 0) <= SCATTER_X_MAX;
  const path = () => {
    let d = '';
    props.result.bins.forEach((b, i) => {
      if (!shown(i)) return;
      d += `${d ? 'L' : 'M'}${x(i).toFixed(1)},${y(b.median!).toFixed(1)}`;
    });
    return d;
  };
  const unit = () => (props.result.diameterPx > 0 ? 'soma diameters' : 'px (no footprint size)');
  return (
    <figure
      class="cala-corr__plot"
      data-testid="corr-plot"
      style={{ '--corr-series': SERIES, '--corr-far': FAR }}
    >
      <canvas
        ref={canvas}
        class="cala-corr__scatter"
        data-testid="corr-scatter"
        data-points={sel().idx.length}
        aria-hidden="true"
      />
      <svg
        class="cala-corr__svg"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Pairwise trace correlation against centre distance: ${props.result.bins
          .map((b) => `${b.label} ${b.median === null ? 'none' : b.median.toFixed(2)}`)
          .join(', ')}`}
      >
        <CorrAxes range={range()} unit={unit()} />
        <Show when={props.result.farMedian !== null}>
          <line
            class="cala-corr__far"
            data-testid="corr-far-line"
            x1={PAD_L}
            x2={W - PAD_R}
            y1={y(props.result.farMedian!)}
            y2={y(props.result.farMedian!)}
          />
        </Show>
        <path class="cala-corr__median" d={path()} />
        <For each={props.result.bins}>
          {(b, i) => (
            <Show when={shown(i())}>
              <line class="cala-corr__iqr" x1={x(i())} x2={x(i())} y1={y(b.q25!)} y2={y(b.q75!)} />
              <circle
                class="cala-corr__dot"
                cx={x(i())}
                cy={y(b.median!)}
                r={3.5}
                data-testid="corr-bin-dot"
              >
                <title>
                  {`${b.label} D: median ${b.median!.toFixed(3)}, IQR ${b.q25!.toFixed(3)} to ${b.q75!.toFixed(3)}, ${b.n.toLocaleString()} pairs`}
                </title>
              </circle>
            </Show>
          )}
        </For>
      </svg>
      <figcaption class="cala-muted num" data-testid="corr-scatter-note">
        {sel().idx.length.toLocaleString()} of {props.result.pairsKept.toLocaleString()} pairs drawn
        {props.result.pairsKept < props.result.pairsTotal
          ? `, thinned uniformly at random from ${props.result.pairsTotal.toLocaleString()}`
          : ''}
        {sel().offX + sel().offY > 0
          ? `; ${(sel().offX + sel().offY).toLocaleString()} off-scale (${sel().offY.toLocaleString()} outside the r range)`
          : ''}
        .
      </figcaption>
    </figure>
  );
}

/**
 * The Correlation tab: the plot's axes from the start, filled on demand (Compute), then the
 * run's figures in one line. Explanations sit in the "?" popover.
 */
export function CorrDistancePanel(props: { cells: CellStore }): JSX.Element {
  const [result, setResult] = createSignal<CorrDistanceResult | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const enabled = () => (props.cells.library()?.ids.length ?? 0) >= 2;

  async function compute() {
    if (busy()) return;
    setError(null);
    const req = corrRequest(props.cells, props.cells.fps());
    if (!req) {
      setError('No traces to correlate yet.');
      return;
    }
    setBusy(true);
    try {
      setResult(await runCorrDistance(req));
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="cala-corr" data-testid="corr-panel">
      <div class="cala-corr__bar">
        <h2 class="panel-label cala-corr__title">Correlation vs distance</h2>
        <HelpTip
          label="About correlation vs distance"
          testid="corr-help"
          popClass="cala-corr__help"
        >
          <p>
            Median correlation of every pair of cell traces against how far apart the cells are.
            Neighbours that share light make it rise at close range. Computed once, on demand, from
            the traces held now: run Extract first for the whole recording.
          </p>
          <p>
            The dotted line is the median r of far pairs (1.5-3 soma diameters apart), the level
            expected with no leak between cells.
          </p>
        </HelpTip>
        <button
          type="button"
          class="btn-secondary btn-small cala-corr__compute"
          disabled={busy() || !enabled()}
          onClick={() => void compute()}
          data-testid="corr-compute"
        >
          {busy() ? 'Computing...' : result() ? 'Recompute' : 'Compute'}
        </button>
      </div>
      <Show when={error()}>
        {(e) => (
          <StatusNote tone="critical" role="alert">
            {e()}
          </StatusNote>
        )}
      </Show>
      <Show
        when={result()}
        fallback={
          <CorrGhost
            message={
              busy()
                ? 'Computing…'
                : enabled()
                  ? 'Compute to plot the cells found so far'
                  : 'Needs at least two cells'
            }
          />
        }
      >
        {(r) => (
          <>
            <Legend
              label="How the plot is drawn"
              testid="corr-caption"
              items={[
                { label: 'pair', color: 'var(--mark-neutral)', mark: 'dot' },
                { label: 'median per bin', color: SERIES, mark: 'dot' },
                { label: 'interquartile range', color: SERIES, mark: 'line' },
                { label: 'far pairs', color: FAR, mark: 'line', dashed: true },
              ]}
            />
            <CorrDistancePlot result={r()} />
            <p class="cala-corr__readout num" data-testid="corr-readout">
              {r().cells} cells · {r().frames.toLocaleString()} frames · D ={' '}
              {r().diameterPx > 0 ? `${r().diameterPx.toFixed(1)} px` : 'unknown'} ·{' '}
              {r().pairsKept.toLocaleString()} pairs within 6 D
              {r().pairsKept < r().pairsTotal
                ? ` (a uniform random ${r().pairsKept.toLocaleString()} of ${r().pairsTotal.toLocaleString()})`
                : ''}
              {r().skipped > 0 ? ` · ${r().skipped} cells skipped (too short or flat)` : ''}
              {r().ms !== undefined ? ` · ${Math.round(r().ms!)} ms` : ''}
            </p>
          </>
        )}
      </Show>
    </div>
  );
}
