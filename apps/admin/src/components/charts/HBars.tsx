import { For, Show, type JSX } from 'solid-js';
import { hideTip, showTip } from './tooltip.tsx';

export interface BarSegment {
  label: string;
  value: number;
  color: string;
}

export interface BarRow {
  label: string;
  value: number;
  /** Secondary text after the value, e.g. a share. */
  note?: string;
  color?: string;
  /** Stacked parts (override color); their sum should equal value. */
  segments?: BarSegment[];
  onClick?: () => void;
}

interface Props {
  rows: BarRow[];
  format?: (n: number) => string;
  /** Scale to this instead of the largest row. */
  max?: number;
}

/** Ranked horizontal bars: label, thin bar from a shared baseline, value at the tip. */
export function HBars(props: Props): JSX.Element {
  const fmt = (n: number) => (props.format ?? ((x: number) => x.toLocaleString('en-US')))(n);
  const max = () => props.max ?? Math.max(1, ...props.rows.map((r) => r.value));
  const tip = (r: BarRow, e: PointerEvent | FocusEvent) =>
    showTip(e, {
      title: r.label,
      rows: r.segments?.length
        ? r.segments.map((s) => ({ color: s.color, label: s.label, value: fmt(s.value) }))
        : [{ color: r.color, label: r.note ?? '', value: fmt(r.value) }],
    });
  return (
    <ul class="hbars">
      <For each={props.rows}>
        {(r) => {
          const inner = (
            <>
              <span class="hbars__label" title={r.label}>
                {r.label}
              </span>
              <span class="hbars__track" aria-hidden="true">
                <Show
                  when={r.segments?.length}
                  fallback={
                    <span
                      class="hbars__fill"
                      style={{
                        width: `${Math.max(r.value > 0 ? 1 : 0, (r.value / max()) * 100)}%`,
                        background: r.color ?? 'var(--series-1)',
                      }}
                    />
                  }
                >
                  <span class="hbars__stack" style={{ width: `${(r.value / max()) * 100}%` }}>
                    <For each={r.segments}>
                      {(s) => (
                        <span
                          class="hbars__seg"
                          style={{ flex: `${s.value} 0 0`, background: s.color }}
                        />
                      )}
                    </For>
                  </span>
                </Show>
              </span>
              <span class="hbars__value">
                {fmt(r.value)}
                <Show when={r.note}>
                  <span class="hbars__note"> {r.note}</span>
                </Show>
              </span>
            </>
          );
          return (
            <li class="hbars__row" onPointerMove={(e) => tip(r, e)} onPointerLeave={hideTip}>
              <Show when={r.onClick} fallback={<div class="hbars__line">{inner}</div>}>
                <button
                  class="hbars__line hbars__line--btn"
                  onClick={r.onClick}
                  onFocus={(e) => tip(r, e)}
                  onBlur={hideTip}
                >
                  {inner}
                </button>
              </Show>
            </li>
          );
        }}
      </For>
    </ul>
  );
}
