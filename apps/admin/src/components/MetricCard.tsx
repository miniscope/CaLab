import { Show, type JSX } from 'solid-js';
import type { Delta } from '../lib/stats.ts';
import { fmtNum } from '../lib/stats.ts';

interface Props {
  label: string;
  value: string | number;
  /** Change vs the previous period; null hides it. */
  delta?: Delta | null;
  /** Whether an increase is good, bad or neither (colours the delta). */
  good?: 'up' | 'down' | 'neutral';
  /** Format the absolute delta when there is no percentage. */
  deltaFormat?: (n: number) => string;
  /** Percent-point delta (for rates) instead of a relative percentage. */
  points?: boolean;
  hint?: string;
  onClick?: () => void;
}

function deltaText(d: Delta, p: Props): string {
  if (Math.abs(d.abs) < 1e-12) return '= vs previous';
  const arrow = d.abs > 0 ? '▲' : '▼';
  if (p.points) return `${arrow} ${Math.abs(d.abs * 100).toFixed(1)} pts vs previous`;
  if (d.pct === null) return `${arrow} ${(p.deltaFormat ?? fmtNum)(Math.abs(d.abs))} vs previous`;
  return `${arrow} ${Math.abs(d.pct * 100).toFixed(0)}% vs previous`;
}

export function MetricCard(props: Props): JSX.Element {
  const tone = () => {
    const d = props.delta;
    if (!d || Math.abs(d.abs) < 1e-12 || !props.good || props.good === 'neutral') return 'flat';
    return d.abs > 0 === (props.good === 'up') ? 'good' : 'bad';
  };
  const body = (
    <>
      <div class="metric__label">
        {props.label}
        <Show when={props.hint}>
          <span class="hint" title={props.hint} aria-label={props.hint} role="note">
            ?
          </span>
        </Show>
      </div>
      <div class="metric__value">{props.value}</div>
      <Show when={props.delta} fallback={<div class="metric__delta">&nbsp;</div>}>
        {(d) => <div class={`metric__delta metric__delta--${tone()}`}>{deltaText(d(), props)}</div>}
      </Show>
    </>
  );
  return (
    <Show when={props.onClick} fallback={<div class="metric">{body}</div>}>
      <button class="metric metric--btn" onClick={() => props.onClick?.()}>
        {body}
      </button>
    </Show>
  );
}
