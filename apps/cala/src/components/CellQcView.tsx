import { createEffect, createMemo, For, Show, type JSX } from 'solid-js';
import { OKABE_ITO, TracePanel } from '@calab/ui/chart';
import type uPlot from 'uplot';
import type { CellStore } from '../lib/cell-store.ts';
import {
  correlation,
  demixVerdict,
  FLAG_UNMEASURED,
  MIN_SNR,
  normalize,
  verdict,
  type Neighbour,
} from '../lib/qc.ts';

const num = (v: number | undefined, d = 2) =>
  v === undefined || !Number.isFinite(v) ? 'n/a' : v.toFixed(d);

/** The selected cell's QC numbers with a plain-language verdict. */
export function CellQcSummary(props: { cells: CellStore; id: number }): JSX.Element {
  const row = () => props.cells.qc()?.byId.get(props.id);
  const v = () => verdict(row());
  const est = () => props.cells.established().get(props.id);
  return (
    <div class="cala-cellqc" data-testid="cell-qc">
      <div class="cala-cellqc__verdict">
        <span class={`cala-qc-badge cala-qc-badge--${v().kind}`} data-testid="cell-qc-verdict">
          {v().label}
        </span>
        <Show when={est() !== undefined}>
          <span class="cala-muted">slow loop: {est() ? 'established' : 'on probation'}</span>
        </Show>
      </div>
      <Show when={row() && !(row()!.flags & FLAG_UNMEASURED)}>
        <dl class="cala-cellqc__grid">
          <dt title={`Peak SNR in noise units; pass needs >= ${MIN_SNR}`}>peak SNR</dt>
          <dd>{num(row()?.peakSnr, 1)}</dd>
          <dt title="Trace vs its own footprint projection (trace fidelity; validated, no threshold)">
            proj r
          </dt>
          <dd>{num(row()?.projR)}</dd>
          <dt title="Variance inflation from overlapping footprints (expected crosstalk; 1 = none)">
            vif
          </dt>
          <dd>{num(row()?.vif)}</dd>
          <dt title="Largest normalised footprint overlap with a neighbour">max overlap</dt>
          <dd>{num(row()?.maxOverlap)}</dd>
          <dt title="Footprint mismatch, relative only (no threshold separates good from bad)">
            fp error
          </dt>
          <dd>{num(row()?.fpError)}</dd>
          <dt title="Descriptive only">events/min</dt>
          <dd>{num(row()?.eventRate, 1)}</dd>
        </dl>
      </Show>
      <For each={v().notes}>{(n) => <p class="cala-muted cala-cellqc__note">{n}</p>}</For>
    </div>
  );
}

const NB_COLORS = [
  OKABE_ITO.orange,
  OKABE_ITO.skyBlue,
  OKABE_ITO.bluishGreen,
  OKABE_ITO.yellow,
  OKABE_ITO.reddishPurple,
  OKABE_ITO.blue,
];
const SELF_COLOR = OKABE_ITO.vermillion;
/** Neighbours shown at most (largest overlap first). */
const MAX_NEIGHBOURS = NB_COLORS.length;
const PAD = 4;

function hexRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/**
 * How well the selected cell is separated from the cells its footprint
 * overlaps: their outlines on a crop of the footprints, their traces over the
 * QC window overlaid (each scaled to its own range), and the pairwise
 * numbers. Two near-identical traces (r > 0.8) mean a split or duplicate.
 */
export function DemixView(props: { cells: CellStore; id: number }): JSX.Element {
  let canvas!: HTMLCanvasElement;
  const c = () => props.cells;
  const row = () => c().qc()?.byId.get(props.id);
  const nbs = createMemo((): Neighbour[] => {
    const list = c().qc()?.neighbours.get(props.id) ?? [];
    return [...list].sort((a, b) => b.overlap - a.overlap).slice(0, MAX_NEIGHBOURS);
  });
  const nbKey = () =>
    nbs()
      .map((n) => n.id)
      .join(',');
  const ids = () => [props.id, ...nbs().map((n) => n.id)];
  const colors = () => [SELF_COLOR, ...nbs().map((_, i) => NB_COLORS[i])];

  // Crop of the footprints (grey, each to its own peak) with coloured outlines.
  createEffect(() => {
    const view = c().library();
    const g = c().geometry();
    const ctx = canvas.getContext('2d');
    if (!view || !g || !ctx) return;
    const want = ids();
    const slots = want.map((id) => view.ids.indexOf(id)).filter((s) => s >= 0);
    if (slots.length === 0) return;
    let y0 = Infinity;
    let x0 = Infinity;
    let y1 = 0;
    let x1 = 0;
    for (const s of slots) {
      const sh = g.shapes[s];
      y0 = Math.min(y0, sh.y0);
      x0 = Math.min(x0, sh.x0);
      y1 = Math.max(y1, sh.y1);
      x1 = Math.max(x1, sh.x1);
    }
    y0 = Math.max(0, y0 - PAD);
    x0 = Math.max(0, x0 - PAD);
    y1 = Math.min(view.height, y1 + PAD);
    x1 = Math.min(view.width, x1 + PAD);
    const w = x1 - x0;
    const h = y1 - y0;
    if (w <= 0 || h <= 0) return;
    const grey = new Float32Array(w * h);
    for (const s of slots) {
      const peak = g.shapes[s].peak || 1;
      for (let k = view.starts[s]; k < view.starts[s + 1]; k++) {
        const p = view.pixels[k];
        const y = Math.floor(p / view.width) - y0;
        const x = (p % view.width) - x0;
        if (y < 0 || x < 0 || y >= h || x >= w) continue;
        grey[y * w + x] = Math.max(grey[y * w + x], view.values[k] / peak);
      }
    }
    canvas.width = w;
    canvas.height = h;
    const img = ctx.createImageData(w, h);
    for (let i = 0; i < w * h; i++) {
      const v = Math.round(200 * Math.max(0, grey[i]));
      img.data.set([v, v, v, 255], i * 4);
    }
    const cols = colors();
    // Neighbours first, the selected cell on top.
    for (let j = want.length - 1; j >= 0; j--) {
      const s = view.ids.indexOf(want[j]);
      if (s < 0) continue;
      const rgb = hexRgb(cols[j]);
      for (const p of g.shapes[s].contour) {
        const y = Math.floor(p / view.width) - y0;
        const x = (p % view.width) - x0;
        if (y < 0 || x < 0 || y >= h || x >= w) continue;
        img.data.set([...rgb, 255], (y * w + x) * 4);
      }
    }
    ctx.putImageData(img, 0, 0);
  });

  /** Traces over the QC window (last minute), raw and normalised. */
  const traces = createMemo(() => {
    c().tick();
    const end = c().frame();
    const n = Math.min(end, Math.round(60 * c().fps()));
    const h = c().history();
    const raw = ids().map((id) => h.range(id, end - n, end));
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = (end - n + i) / c().fps();
    return { x, raw, norm: raw.map(normalize) };
  });
  const windowR = createMemo(() => {
    const [self, ...rest] = traces().raw;
    return rest.map((t) => correlation(self, t));
  });
  const data = (): [number[], ...number[][]] => {
    const t = traces();
    // uPlot skips null, not NaN (a NaN breaks its auto range).
    const gaps = (v: Float64Array) =>
      Array.from(v, (y) => (Number.isFinite(y) ? y : null)) as number[];
    return [Array.from(t.x), ...t.norm.map(gaps)];
  };
  const series = (): uPlot.Series[] => [
    {},
    ...ids().map((id, i) => ({
      label: `#${id}`,
      stroke: colors()[i],
      width: i === 0 ? 1.6 : 1.1,
    })),
  ];

  return (
    <div class="cala-demix" data-testid="demix-view">
      <p class="cala-demix__verdict" data-testid="demix-verdict">
        {demixVerdict(row(), nbs())}
      </p>
      <p class="cala-muted cala-demix__self">
        <span class="cala-legend__swatch" style={{ background: SELF_COLOR }} />#{props.id}: vif{' '}
        {num(row()?.vif)}, max overlap {num(row()?.maxOverlap)}; red rows: trace r &gt; 0.8
      </p>
      <div class="cala-demix__top">
        <canvas
          ref={canvas}
          class="cala-demix__crop"
          aria-label="Selected cell and overlapping neighbours"
        />
        <table class="cala-demix__table">
          <thead>
            <tr>
              <th>cell</th>
              <th title="Normalised footprint overlap">overlap</th>
              <th title="Trace correlation over the QC window (QC monitor)">r</th>
              <th title="Trace correlation over the plotted window, computed here">r shown</th>
            </tr>
          </thead>
          <tbody>
            <For each={nbs()}>
              {(n, i) => (
                <tr classList={{ 'cala-demix__pair': n.r > 0.8 }}>
                  <td>
                    <span class="cala-legend__swatch" style={{ background: NB_COLORS[i()] }} />
                    <button type="button" class="cala-link" onClick={() => c().select(n.id)}>
                      #{n.id}
                    </button>
                  </td>
                  <td>{num(n.overlap)}</td>
                  <td>{num(n.r)}</td>
                  <td>{num(windowR()[i()])}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
      <Show
        when={nbs().length > 0}
        fallback={<p class="cala-muted">No overlapping neighbours: nothing to demix.</p>}
      >
        <Show when={nbKey()} keyed>
          <TracePanel
            data={data}
            series={series()}
            height={130}
            syncKey="cala-demix"
            xLabel="Time (s), each trace scaled to its own range"
            hideYValues
          />
        </Show>
      </Show>
    </div>
  );
}
