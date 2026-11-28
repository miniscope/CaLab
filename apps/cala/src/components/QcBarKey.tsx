import { Show, type JSX } from 'solid-js';
import type { QcMedian } from '../lib/qc-view.ts';

/**
 * The key to a QC bar's two markers: the dashed tick is the rule's threshold
 * ("pass ≥ 5"), the triangle is the median of the measured cells.
 */
export function QcBarKey(props: {
  threshold?: string;
  median?: QcMedian | null;
  digits: number;
}): JSX.Element {
  return (
    <span class="cala-bar-key" data-testid="qc-bar-key">
      <Show when={props.threshold}>
        <span class="cala-bar-key__item" title="The dashed tick on each bar">
          <i class="cala-bar-key__tick" aria-hidden="true" />
          {props.threshold}
        </span>
      </Show>
      <Show when={props.median}>
        {(m) => (
          <span class="cala-bar-key__item" title={m().title}>
            <i class="cala-bar-key__median" aria-hidden="true" />
            median {m().value.toFixed(props.digits)}
          </span>
        )}
      </Show>
    </span>
  );
}
