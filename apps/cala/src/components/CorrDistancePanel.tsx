/**
 * The Correlation tab (docs/stages.md, "Correlation vs distance"): median
 * pairwise trace correlation against centre distance, a check for incomplete
 * demixing of neighbouring cells. Computed once on demand (button), in a
 * worker, from the traces and footprints the store holds; it never runs with
 * the pipeline. The y axis is fixed at -0.1 to 0.5 and only grows, in steps of
 * 0.1, when a bin's quartile falls outside it.
 */
import { createSignal, For, Show, type JSX } from 'solid-js';
import type { CellStore } from '../lib/cell-store.ts';
import { corrRequest, runCorrDistance } from '../lib/corr-distance-client.ts';
import type { CorrDistanceResult } from '../lib/corr-distance.ts';

const W = 360;
const H = 210;
const PAD_L = 38;
const PAD_R = 8;
const PAD_T = 10;
const PAD_B = 34;
const COLOR = '#0072b2';

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
  const x = (i: number) => PAD_L + ((W - PAD_L - PAD_R) * (i + 0.5)) / props.result.bins.length;
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
  const path = () => {
    let d = '';
    props.result.bins.forEach((b, i) => {
      if (b.median === null) return;
      d += `${d ? 'L' : 'M'}${x(i).toFixed(1)},${y(b.median).toFixed(1)}`;
    });
    return d;
  };
  const unit = () => (props.result.diameterPx > 0 ? 'soma diameters' : 'px (no footprint size)');
  return (
    <figure class="cala-corr__plot" data-testid="corr-plot">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Pairwise trace correlation against centre distance: ${props.result.bins
          .map((b) => `${b.label} ${b.median === null ? 'none' : b.median.toFixed(2)}`)
          .join(', ')}`}
      >
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
              <Show when={b.median !== null}>
                <line
                  x1={x(i())}
                  x2={x(i())}
                  y1={y(b.q25!)}
                  y2={y(b.q75!)}
                  stroke={COLOR}
                  stroke-width="1.5"
                />
                <circle cx={x(i())} cy={y(b.median!)} r={3.5} fill={COLOR}>
                  <title>
                    {`${b.label} D: median ${b.median!.toFixed(3)}, IQR ${b.q25!.toFixed(3)} to ${b.q75!.toFixed(3)}, ${b.n.toLocaleString()} pairs`}
                  </title>
                </circle>
              </Show>
              <text
                class="cala-corr__tick"
                x={x(i())}
                y={H - PAD_B + 12}
                text-anchor="middle"
                data-testid="corr-bin-label"
              >
                {b.label}
              </text>
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
              Dots: median r per distance bin, bars: interquartile range. Dotted line: median r of
              far pairs (1.5-3 soma diameters apart), the level expected with no leak between cells.
            </p>
            <p class="cala-muted" data-testid="corr-readout">
              {r().cells} cells, {r().frames.toLocaleString()} frames; D ={' '}
              {r().diameterPx > 0 ? `${r().diameterPx.toFixed(1)} px` : 'unknown'}; pairs: all{' '}
              {r().pairsNear.toLocaleString()} within 3 D plus {r().pairsFar.toLocaleString()} of{' '}
              {r().pairsFarTotal.toLocaleString()} farther
              {r().skipped > 0 ? `; ${r().skipped} cells skipped (too short or flat)` : ''}
              {r().ms !== undefined ? `; ${Math.round(r().ms!)} ms` : ''}.
            </p>
          </>
        )}
      </Show>
    </div>
  );
}
