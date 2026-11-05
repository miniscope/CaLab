/**
 * Single-line, wrapping key for a chart's marks. Each swatch is drawn with
 * the same CSS class (or CSS colour) as the mark it names, so the key always
 * matches the plot in either theme.
 */

import { For, Match, Switch, type JSX } from 'solid-js';
import { viridisCss } from '../chart/colormap.ts';

export interface LegendItem {
  /**
   * dot: filled point; ring: hollow point; line: stroke; area: filled
   * rectangle; gradient: the viridis rank ramp.
   */
  mark: 'dot' | 'ring' | 'line' | 'area' | 'gradient';
  label: string;
  /** Class of the plot element this names (line and area marks). */
  className?: string;
  /** CSS colour (dot and ring marks), e.g. `var(--ov-point-strong)`. */
  color?: string;
}

const GRADIENT_STOPS = [0, 0.25, 0.5, 0.75, 1];

function Swatch(props: { item: LegendItem }): JSX.Element {
  const it = () => props.item;
  return (
    <svg class="ov-legend__swatch" width="14" height="10" viewBox="0 0 14 10" aria-hidden="true">
      <Switch>
        <Match when={it().mark === 'dot'}>
          <circle cx="7" cy="5" r="3" style={{ fill: it().color }} />
        </Match>
        <Match when={it().mark === 'ring'}>
          <circle
            cx="7"
            cy="5"
            r="3"
            style={{ fill: 'none', stroke: it().color, 'stroke-width': '1.4' }}
          />
        </Match>
        <Match when={it().mark === 'line'}>
          <line class={it().className} x1="1" x2="13" y1="5" y2="5" />
        </Match>
        <Match when={it().mark === 'area'}>
          <rect class={it().className} x="1" y="1" width="12" height="8" />
        </Match>
        <Match when={it().mark === 'gradient'}>
          <defs>
            <linearGradient id="ov-legend-viridis">
              <For each={GRADIENT_STOPS}>
                {(t) => <stop offset={t} stop-color={viridisCss(t)} />}
              </For>
            </linearGradient>
          </defs>
          <rect x="1" y="2" width="12" height="6" fill="url(#ov-legend-viridis)" />
        </Match>
      </Switch>
    </svg>
  );
}

export function ChartLegend(props: { items: readonly LegendItem[] }): JSX.Element {
  return (
    <ul class="ov-legend" aria-label="legend">
      <For each={props.items}>
        {(item) => (
          <li class="ov-legend__item" data-mark={item.mark}>
            <Swatch item={item} />
            <span>{item.label}</span>
          </li>
        )}
      </For>
    </ul>
  );
}
