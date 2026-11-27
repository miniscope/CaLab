import { For, Show, type JSX } from 'solid-js';

/** One legend entry. The swatch is drawn as the mark it names. */
export interface LegendItem {
  label: string;
  /** Colour of the mark (a token reference). */
  color: string;
  /** How the series is drawn: a filled block (default), a line, or a dot. */
  mark?: 'swatch' | 'line' | 'dot';
  /** Hatched, where the mark itself is hatched. */
  hatched?: boolean;
  /** A dashed line, where the series is dashed (line marks). */
  dashed?: boolean;
  /** An optional figure after the label, outside the swatch. */
  value?: JSX.Element;
}

export interface LegendProps {
  items: LegendItem[];
  /** Accessible name of the list (e.g. "Work by kind"). */
  label?: string;
  class?: string;
  testid?: string;
}

/** A one-row legend: each entry's swatch is the mark itself, then its label in the text ink. */
export function Legend(p: LegendProps): JSX.Element {
  return (
    <ul class={`legend${p.class ? ' ' + p.class : ''}`} aria-label={p.label} data-testid={p.testid}>
      <For each={p.items}>
        {(it) => (
          <li class="legend__item">
            <span
              class={`legend__mark legend__mark--${it.mark ?? 'swatch'}`}
              classList={{
                'legend__mark--hatched': !!it.hatched,
                'legend__mark--dashed': !!it.dashed,
              }}
              style={{ '--legend-color': it.color }}
              aria-hidden="true"
            />
            <span class="legend__label">{it.label}</span>
            <Show when={it.value !== undefined}>
              <span class="legend__value num">{it.value}</span>
            </Show>
          </li>
        )}
      </For>
    </ul>
  );
}
