import { For, Show, type JSX } from 'solid-js';
import { fmtNum, fmtPct } from '../../lib/stats.ts';

export interface FunnelRow {
  label: string;
  count: number;
  ofFirst: number | null;
  ofPrev: number | null;
}

/** Funnel as ordinal one-hue bars: width is the count, text gives both drop-off rates. */
export function Funnel(props: { steps: FunnelRow[]; firstLabel?: string }): JSX.Element {
  const max = () => Math.max(1, props.steps[0]?.count ?? 1);
  return (
    <ol class="funnel">
      <For each={props.steps}>
        {(s, i) => (
          <li class="funnel__row">
            <span class="funnel__label">{s.label}</span>
            <span class="funnel__track" aria-hidden="true">
              <span
                class="funnel__fill"
                style={{
                  width: `${Math.max(s.count > 0 ? 1 : 0, (s.count / max()) * 100)}%`,
                  background: `var(--seq-${Math.min(5, i() + 1)})`,
                }}
              />
            </span>
            <span class="funnel__value">
              <strong>{fmtNum(s.count)}</strong>
              <Show when={i() > 0}>
                <span class="funnel__note">
                  {fmtPct(s.ofFirst)} of {props.firstLabel ?? 'visits'}, {fmtPct(s.ofPrev)} of
                  previous
                </span>
              </Show>
            </span>
          </li>
        )}
      </For>
    </ol>
  );
}
