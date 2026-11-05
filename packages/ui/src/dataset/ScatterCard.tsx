/**
 * Scatter plot card: points on a canvas (cheap at 10k points), axes, shaded
 * x-interval and one reference curve with an optional band in SVG. Click a
 * point to pick it, drag a rectangle to brush, hover for a tooltip.
 */

import { createEffect, createMemo, createSignal, For, Show, type JSX } from 'solid-js';
import { labeledTicks, makeScale, tickTarget } from './chart-scales.ts';
import { OverviewCard, createBrush, createElementSize } from './OverviewCard.tsx';

export type PointStyle = 'default' | 'strong' | 'dim' | 'accent' | 'flag';

export interface ScatterCurve {
  fn: (x: number) => number;
  lo?: (x: number) => number;
  hi?: (x: number) => number;
  label?: string;
}

export interface ScatterCardProps {
  title: string;
  help?: JSX.Element;
  footer?: JSX.Element;
  x: () => readonly number[];
  y: () => readonly number[];
  ids: () => readonly number[];
  xRange: () => [number, number];
  yRange: () => [number, number];
  logX?: boolean;
  xLabel: string;
  yLabel: string;
  /** Format y ticks (e.g. as percent). */
  yTickFormat?: (v: number) => string;
  curve?: () => ScatterCurve | null;
  shade?: { lo: number; hi: number; label?: string };
  styleOf?: (id: number) => PointStyle;
  selected?: () => number | null;
  onPick?: (id: number) => void;
  onBrush?: (ids: number[] | null) => void;
  tooltip?: (id: number) => string;
  emptyText?: string;
  'data-testid'?: string;
}

const M = { l: 36, r: 10, t: 10, b: 28 };
const HIT_PX = 8;

function cssVar(el: Element, name: string, fallback: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim() || fallback;
}

export function ScatterCard(props: ScatterCardProps): JSX.Element {
  let host: HTMLDivElement | undefined;
  let canvas: HTMLCanvasElement | undefined;
  const size = createElementSize(() => host, { width: 400, height: 220 });
  const W = () => size().width;
  const H = () => Math.max(80, size().height);
  const [hover, setHover] = createSignal<{ id: number; px: number; py: number } | null>(null);

  const x = createMemo(() => makeScale(props.xRange(), M.l, W() - M.r, !!props.logX));
  const y = createMemo(() => makeScale(props.yRange(), H() - M.b, M.t));

  const points = createMemo(() => {
    const xs = props.x();
    const ys = props.y();
    const ids = props.ids();
    const out: { id: number; px: number; py: number }[] = [];
    for (let i = 0; i < ids.length; i++) {
      if (!Number.isFinite(xs[i]) || !Number.isFinite(ys[i])) continue;
      if (props.logX && xs[i] <= 0) continue;
      out.push({ id: ids[i], px: x()(xs[i]), py: y()(ys[i]) });
    }
    return out;
  });

  const nearest = (mx: number, my: number) => {
    let best: { id: number; px: number; py: number } | null = null;
    let bd = HIT_PX;
    for (const p of points()) {
      const d = Math.hypot(p.px - mx, p.py - my);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best;
  };

  createEffect(() => {
    const c = canvas;
    if (!c) return;
    const ctx = c.getContext('2d');
    const w = W();
    const h = H();
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    c.style.width = `${w}px`;
    c.style.height = `${h}px`;
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const colors: Record<PointStyle, string> = {
      default: cssVar(c, '--ov-point', 'rgba(97,97,97,0.55)'),
      strong: cssVar(c, '--ov-point-strong', 'rgba(26,26,26,0.85)'),
      dim: cssVar(c, '--ov-point-dim', 'rgba(158,158,158,0.25)'),
      accent: cssVar(c, '--accent', '#2171b5'),
      flag: cssVar(c, '--error', '#d32f2f'),
    };
    const pts = points();
    // Draw in layers so emphasised points sit on top.
    const order: PointStyle[] = ['dim', 'default', 'strong', 'flag', 'accent'];
    for (const layer of order) {
      for (const p of pts) {
        const s = props.styleOf?.(p.id) ?? 'default';
        if (s !== layer) continue;
        ctx.beginPath();
        ctx.arc(p.px, p.py, s === 'accent' ? 3.2 : 2.6, 0, Math.PI * 2);
        if (s === 'flag') {
          ctx.strokeStyle = colors.flag;
          ctx.lineWidth = 1.4;
          ctx.stroke();
        } else {
          ctx.fillStyle = colors[s];
          ctx.fill();
        }
      }
    }
  });

  const curvePath = (f: (v: number) => number) => {
    const [a, b] = props.xRange();
    const n = 80;
    let s = '';
    for (let i = 0; i <= n; i++) {
      const v = props.logX ? a * Math.pow(b / a, i / n) : a + ((b - a) * i) / n;
      const yy = f(v);
      if (!Number.isFinite(yy)) continue;
      s += `${s ? 'L' : 'M'}${x()(v).toFixed(1)},${y()(yy).toFixed(1)}`;
    }
    return s;
  };
  const bandPath = (c: ScatterCurve) => {
    if (!c.lo || !c.hi) return '';
    const up = curvePath(c.hi);
    const lo = curvePath(c.lo).slice(1).split('L').reverse();
    return up ? `${up}L${lo.join('L')}Z` : '';
  };

  const brush = createBrush({
    onBrush(r) {
      const x0 = Math.min(r.x0, r.x1);
      const x1 = Math.max(r.x0, r.x1);
      const y0 = Math.min(r.y0, r.y1);
      const y1 = Math.max(r.y0, r.y1);
      const ids = points()
        .filter((p) => p.px >= x0 && p.px <= x1 && p.py >= y0 && p.py <= y1)
        .map((p) => p.id);
      props.onBrush?.(ids);
    },
    onClick(mx, my) {
      const p = nearest(mx, my);
      if (p) props.onPick?.(p.id);
      else props.onBrush?.(null);
    },
  });

  const selectedPoint = () => {
    const s = props.selected?.();
    if (s == null) return null;
    return points().find((p) => p.id === s) ?? null;
  };

  return (
    <OverviewCard
      title={props.title}
      help={props.help}
      footer={props.footer}
      data-testid={props['data-testid']}
      class="ov-card--scatter"
    >
      <div class="ov-hist ov-scatter" ref={host}>
        <svg class="ov-svg" width={W()} height={H()} aria-hidden="true">
          <Show when={props.shade}>
            {(s) => {
              const x0 = () => Math.max(M.l, x()(Math.max(s().lo, props.xRange()[0])));
              const x1 = () => Math.min(W() - M.r, x()(s().hi));
              return (
                <Show when={x1() > x0()}>
                  <rect
                    class="ov-shade"
                    x={x0()}
                    y={M.t}
                    width={x1() - x0()}
                    height={H() - M.t - M.b}
                  />
                  <text class="ov-shade__label" x={x0() + 3} y={M.t + 9}>
                    {s().label}
                  </text>
                </Show>
              );
            }}
          </Show>
          <For each={labeledTicks(y(), 4)}>
            {(t) => (
              <>
                <line class="ov-grid" x1={M.l} x2={W() - M.r} y1={y()(t.v)} y2={y()(t.v)} />
                <text class="ov-tick" x={M.l - 4} y={y()(t.v) + 3} text-anchor="end">
                  {props.yTickFormat ? props.yTickFormat(t.v) : t.label}
                </text>
              </>
            )}
          </For>
        </svg>
        <canvas class="ov-canvas" ref={canvas} />
        <svg
          class="ov-svg ov-svg--fg"
          width={W()}
          height={H()}
          role="img"
          aria-label={props.title}
          {...brush.handlers}
          onPointerMove={(e) => {
            brush.handlers.onPointerMove(e);
            const r = (e.currentTarget as Element).getBoundingClientRect();
            setHover(nearest(e.clientX - r.left, e.clientY - r.top));
          }}
          onPointerLeave={() => setHover(null)}
        >
          <Show when={props.curve?.()}>
            {(c) => (
              <>
                <path class="ov-curve-band" d={bandPath(c())} />
                <path class="ov-curve-main" d={curvePath(c().fn)} />
              </>
            )}
          </Show>
          <Show when={selectedPoint()}>
            {(p) => (
              <circle class="ov-halo" cx={p().px} cy={p().py} r={6}>
                <title>Cell {p().id}</title>
              </circle>
            )}
          </Show>
          <line class="ov-axis" x1={M.l} x2={W() - M.r} y1={H() - M.b} y2={H() - M.b} />
          <For each={labeledTicks(x(), tickTarget(W() - M.l - M.r))}>
            {(t) => (
              <text class="ov-tick" x={x()(t.v)} y={H() - M.b + 11} text-anchor="middle">
                {t.label}
              </text>
            )}
          </For>
          <text class="ov-axis-label" x={(M.l + W() - M.r) / 2} y={H() - 2} text-anchor="middle">
            {props.xLabel}
          </text>
          <text
            class="ov-axis-label"
            transform={`translate(9 ${(M.t + H() - M.b) / 2}) rotate(-90)`}
            text-anchor="middle"
          >
            {props.yLabel}
          </text>
          <Show when={brush.active()}>
            {(b) => (
              <rect
                class="ov-brush"
                x={Math.min(b().x0, b().x1)}
                y={Math.min(b().y0, b().y1)}
                width={Math.abs(b().x1 - b().x0)}
                height={Math.abs(b().y1 - b().y0)}
              />
            )}
          </Show>
        </svg>
        <Show when={hover() && props.tooltip}>
          <div
            class="ov-tooltip"
            style={{
              left: `${Math.min(hover()!.px + 10, W() - 170)}px`,
              top: `${Math.max(0, hover()!.py - 40)}px`,
            }}
          >
            {props.tooltip!(hover()!.id)}
          </div>
        </Show>
        <Show when={points().length === 0 && props.emptyText}>
          <div class="ov-empty ov-empty--overlay">{props.emptyText}</div>
        </Show>
      </div>
    </OverviewCard>
  );
}
