import type { JSX } from 'solid-js';

export interface WorkerIndicatorProps {
  count: number;
}

export function WorkerIndicator(props: WorkerIndicatorProps): JSX.Element {
  return (
    <span class="worker-indicator" title={`${props.count} solver workers allocated`}>
      <span class="worker-indicator__icon" aria-hidden="true">
        &#x2699;
      </span>
      <span class="worker-indicator__count">{props.count}w</span>
    </span>
  );
}
