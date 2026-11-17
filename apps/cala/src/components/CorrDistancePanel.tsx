/**
 * The Correlation tab (docs/stages.md, "Correlation vs distance"): median
 * pairwise trace correlation against centre distance, a check for incomplete
 * demixing of neighbouring cells. Computed once on demand (button), in a
 * worker, from the traces and footprints the store holds; it never runs with
 * the pipeline. The y axis is fixed at -0.1 to 0.5 and only grows, in steps of
 * 0.1, when a bin's quartile falls outside it.
 */
import { createEffect, createMemo, createSignal, For, Show, type JSX } from 'solid-js';
import type { CellStore } from '../lib/cell-store.ts';
import { corrRequest, runCorrDistance } from '../lib/corr-distance-client.ts';
import {
  NEAR_D,
  SCATTER_X_MAX,
  selectScatter,
  type CorrDistanceResult,
} from '../lib/corr-distance.ts';

const W = 360;
const H = 210;
const PAD_L = 38;
const PAD_R = 8;
const PAD_T = 10;
const PAD_B = 34;
const COLOR = '#0072b2';
const DOT = '#7f8c9a';

/** The y range: -0.1 to 0.5, widened to the next 0.1 only when the data needs it. */
export function corrYRange(res: Pick<CorrDistanceResult, 'bins' | 'farMedian'>): [number, number] {
  let lo = -0.1;
  let hi = 0.5;
  for (const b of res.bins) {
    if (b.q25 !== null) lo = Math.min(lo, Math.floor(b.q25 * 10 - 1e-9) / 10);
    if (b.q75 !== null) hi = Math.max(hi, Math.ceil(b.q75 * 10 - 1e-9) / 10);
  }
  return [Math.round(lo * 10) / 10, Math.round(hi * 10) / 10];
}

export function CorrDistancePlot(props: { result: CorrDistanceResult }): JSX.Element {
  const range = () => corrYRange(props.result);
  // Continuous x in soma diameters (px when the footprint size is unknown).
  const xMax = () => (props.result.diameterPx > 0 ? SCATTER_X_MAX : 2 * NEAR_D);
  const xv = (d: number) => PAD_L + ((W - PAD_L - PAD_R) * Math.min(d, xMax())) / xMax();
  const x = (i: number) => xv(props.result.bins[i].medianDist ?? 0);
  const xTicks = () => Array.from({ length: xMax() + 1 }, (_, i) => i);
  const sel = createMemo(() => selectScatter(props.result, xMax(), range()));
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
    ctx.fillStyle = DOT;
    ctx.globalAlpha = 0.22;
    const px = (W - PAD_L - PAD_R) / xMax();
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
  const y = (v: number) => {
    const [lo, hi] = range();
    return PAD_T + (H - PAD_T - PAD_B) * (1 - (v - lo) / (hi - lo));
  };
  const ticks = () => {
    const [lo, hi] = range();
    const out: number[] = [];
    for (let v = lo; v <= hi + 1e-9; v += 0.1) out.push(Math.round(v * 10) / 10);
    return out;
  };
  // A bin whose median distance lies beyond the x extent is not drawn (the far line covers it).
  const shown = (i: number) =>
    props.result.bins[i].median !== null && (props.result.bins[i].medianDist ?? 0) <= xMax();
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
    <figure class="cala-corr__plot" data-testid="corr-plot">
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
        <For each={xTicks()}>
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
                {v === xMax() ? `${v}+` : v}
              </text>
            </>
          )}
        </For>
        <For each={ticks()}>
          {(v) => (
            <>
              <line
                class={v === 0 ? 'cala-corr__zero' : 'cala-corr__grid'}
                x1={PAD_L}
                x2={W - PAD_R}
                y1={y(v)}
                y2={y(v)}
              />
              <text class="cala-corr__tick" x={PAD_L - 4} y={y(v) + 3} text-anchor="end">
                {v.toFixed(1)}
              </text>
            </>
          )}
        </For>
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
        <path d={path()} fill="none" stroke={COLOR} stroke-width="2" />
        <For each={props.result.bins}>
          {(b, i) => (
            <>
              <Show when={shown(i())}>
                <line
                  x1={x(i())}
                  x2={x(i())}
                  y1={y(b.q25!)}
                  y2={y(b.q75!)}
                  stroke={COLOR}
                  stroke-width="1.5"
                />
                <circle
                  cx={x(i())}
                  cy={y(b.median!)}
                  r={3.5}
                  fill={COLOR}
                  stroke="#fff"
                  stroke-width="1"
                  data-testid="corr-bin-dot"
                >
                  <title>
                    {`${b.label} D: median ${b.median!.toFixed(3)}, IQR ${b.q25!.toFixed(3)} to ${b.q75!.toFixed(3)}, ${b.n.toLocaleString()} pairs`}
                  </title>
                </circle>
              </Show>
            </>
          )}
        </For>
        <text class="cala-corr__tick" x={(PAD_L + W - PAD_R) / 2} y={H - 4} text-anchor="middle">
          centre distance ({unit()})
        </text>
        <text
          class="cala-corr__tick"
          transform={`translate(9 ${(PAD_T + H - PAD_B) / 2}) rotate(-90)`}
          text-anchor="middle"
        >
          pairwise r (high-passed)
        </text>
      </svg>
      <figcaption class="cala-muted" data-testid="corr-scatter-note">
        {sel().near.toLocaleString()} near and {sel().far.toLocaleString()} far pairs drawn
        {sel().offX + sel().offY > 0
          ? `; ${(sel().offX + sel().offY).toLocaleString()} off-scale (${sel().offY.toLocaleString()} outside the r range, ${sel().offX.toLocaleString()} beyond ${xMax()} ${props.result.diameterPx > 0 ? 'D' : 'px'})`
          : ''}
        .
      </figcaption>
    </figure>
  );
}

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
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="cala-corr" data-testid="corr-panel">
      <p class="cala-muted">
        Median correlation of every pair of cell traces against how far apart the cells are.
        Neighbours that share light make this rise at close range.
      </p>
      <div class="cala-corr__bar">
        <button
          type="button"
          class="btn-secondary btn-small"
          disabled={busy() || !enabled()}
          onClick={() => void compute()}
          data-testid="corr-compute"
        >
          {busy() ? 'Computing...' : result() ? 'Recompute' : 'Compute'}
        </button>
        <span class="cala-muted">
          Once, on demand, from the traces held now (run Extract first for the whole recording).
        </span>
      </div>
      <Show when={error()}>
        {(e) => (
          <p class="cala-warning" role="alert">
            {e()}
          </p>
        )}
      </Show>
      <Show when={result()}>
        {(r) => (
          <>
            <CorrDistancePlot result={r()} />
            <p class="cala-muted" data-testid="corr-caption">
              Grey points: individual pairs. Blue dots: median r per distance bin, at the bin's
              median distance, bars: interquartile range (a bin centred beyond 6 D is left out).
              Dotted line: median r of far pairs (1.5-3 soma diameters apart), the level expected
              with no leak between cells.
            </p>
            <p class="cala-muted" data-testid="corr-readout">
              {r().cells} cells, {r().frames.toLocaleString()} frames; D ={' '}
              {r().diameterPx > 0 ? `${r().diameterPx.toFixed(1)} px` : 'unknown'}; pairs: all{' '}
              {r().pairsNear.toLocaleString()} within 3 D plus {r().pairsFar.toLocaleString()} of{' '}
              {r().pairsFarTotal.toLocaleString()} farther (at most 10,000 of them drawn)
              {r().skipped > 0 ? `; ${r().skipped} cells skipped (too short or flat)` : ''}
              {r().ms !== undefined ? `; ${Math.round(r().ms!)} ms` : ''}.
            </p>
          </>
        )}
      </Show>
    </div>
  );
}
