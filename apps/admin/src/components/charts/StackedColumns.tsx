import { createMemo, createSignal, For, onCleanup, onMount, Show, type JSX } from 'solid-js';
import { Legend } from './ChartCard.tsx';
import { hideTip, showTip } from './tooltip.tsx';

export interface ColumnSeries {
  key: string;
  label: string;
  color: string;
  values: number[];
}

interface Props {
  categories: string[];
  series: ColumnSeries[];
  height?: number;
  /** Format a value for axis and tooltip. */
  format?: (n: number) => string;
  /** Short label for the x axis; defaults to MM-DD for dates, else the raw category. */
  xLabel?: (c: string) => string;
  ariaLabel: string;
}

const M = { l: 40, r: 8, t: 8, b: 22 };

export function niceMax(v: number): number {
  if (!(v > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

function roundTopPath(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

const defaultX = (c: string) => (/^\d{4}-\d{2}-\d{2}$/.test(c) ? c.slice(5) : c);

export function StackedColumns(props: Props): JSX.Element {
  let host!: HTMLDivElement;
  const [width, setWidth] = createSignal(640);
  const [hover, setHover] = createSignal<number | null>(null);
  onMount(() => {
    setWidth(host.clientWidth || 640);
    const ro = new ResizeObserver(() => setWidth(host.clientWidth || 640));
    ro.observe(host);
    onCleanup(() => ro.disconnect());
  });

  const height = () => props.height ?? 180;
  const fmt = (n: number) => (props.format ?? ((x: number) => x.toLocaleString('en-US')))(n);
  const totals = createMemo(() =>
    props.categories.map((_, i) => props.series.reduce((a, s) => a + (s.values[i] || 0), 0)),
  );
  const yMax = createMemo(() => niceMax(Math.max(0, ...totals())));
  const plotW = () => Math.max(40, width() - M.l - M.r);
  const plotH = () => height() - M.t - M.b;
  const slotW = () => plotW() / Math.max(1, props.categories.length);
  const barW = () => Math.max(2, Math.min(24, slotW() * 0.7));
  const y = (v: number) => M.t + plotH() - (v / yMax()) * plotH();
  const ticks = () => [0, 0.25, 0.5, 0.75, 1].map((f) => f * yMax());
  const every = () => Math.max(1, Math.ceil(64 / slotW()));
  const xl = (c: string) => (props.xLabel ?? defaultX)(c);

  const tipFor = (i: number, e: PointerEvent | FocusEvent) =>
    showTip(e, {
      title: props.categories[i],
      rows: [
        ...props.series
          .filter((s) => (s.values[i] || 0) > 0 || props.series.length === 1)
          .map((s) => ({ color: s.color, label: s.label, value: fmt(s.values[i] || 0) })),
        ...(props.series.length > 1 ? [{ label: 'total', value: fmt(totals()[i]) }] : []),
      ],
    });

  return (
    <div class="plot" ref={host}>
      <Show when={props.series.length > 1}>
        <Legend items={props.series.map((s) => ({ label: s.label, color: s.color }))} />
      </Show>
      <svg
        width={width()}
        height={height()}
        role="img"
        aria-label={props.ariaLabel}
        onPointerLeave={() => {
          setHover(null);
          hideTip();
        }}
      >
        <For each={ticks()}>
          {(t) => (
            <g>
              <line class="plot__grid" x1={M.l} x2={width() - M.r} y1={y(t)} y2={y(t)} />
              <text class="plot__tick" x={M.l - 6} y={y(t) + 3} text-anchor="end">
                {fmt(t)}
              </text>
            </g>
          )}
        </For>
        <line class="plot__axis" x1={M.l} x2={width() - M.r} y1={y(0)} y2={y(0)} />
        <For each={props.categories}>
          {(c, i) => {
            const cx = () => M.l + slotW() * i() + slotW() / 2;
            const segs = () => {
              let acc = 0;
              const out: { x: number; y: number; h: number; color: string; top: boolean }[] = [];
              const live = props.series.filter((s) => (s.values[i()] || 0) > 0);
              live.forEach((s, k) => {
                const v = s.values[i()] || 0;
                const y0 = y(acc + v);
                const h = Math.max(1, y(acc) - y0 - (k < live.length - 1 ? 1 : 0));
                out.push({
                  x: cx() - barW() / 2,
                  y: y0,
                  h,
                  color: s.color,
                  top: k === live.length - 1,
                });
                acc += v;
              });
              return out;
            };
            return (
              <g>
                <Show when={hover() === i()}>
                  <rect
                    class="plot__hover"
                    x={M.l + slotW() * i()}
                    y={M.t}
                    width={slotW()}
                    height={plotH()}
                  />
                </Show>
                <For each={segs()}>
                  {(s) =>
                    s.top && s.h > 3 ? (
                      <path d={roundTopPath(s.x, s.y, barW(), s.h, 3)} fill={s.color} />
                    ) : (
                      <rect x={s.x} y={s.y} width={barW()} height={s.h} fill={s.color} />
                    )
                  }
                </For>
                <Show when={i() % every() === 0}>
                  <text class="plot__tick" x={cx()} y={height() - 6} text-anchor="middle">
                    {xl(c)}
                  </text>
                </Show>
                <rect
                  x={M.l + slotW() * i()}
                  y={M.t}
                  width={slotW()}
                  height={plotH()}
                  fill="transparent"
                  tabindex="0"
                  aria-label={`${c}: ${fmt(totals()[i()])}`}
                  onPointerMove={(e) => {
                    setHover(i());
                    tipFor(i(), e);
                  }}
                  onFocus={(e) => {
                    setHover(i());
                    tipFor(i(), e);
                  }}
                  onBlur={() => {
                    setHover(null);
                    hideTip();
                  }}
                />
              </g>
            );
          }}
        </For>
      </svg>
    </div>
  );
}
