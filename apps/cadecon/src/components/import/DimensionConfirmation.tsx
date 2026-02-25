import { Show, type JSX } from 'solid-js';
import {
  effectiveShape,
  swapped,
  setSwapped,
  setDimensionsConfirmed,
} from '../../lib/data-store.ts';

export function DimensionConfirmation(): JSX.Element {
  return (
    <div class="card">
      <h3 class="card__title">Confirm Dimensions</h3>

      <Show when={effectiveShape()}>
        {(shape) => (
          <>
            <div class="dimension-display">
              <div class="dimension-display__values">
                <div class="dimension-value">
                  <span class="dimension-value__label">Cells</span>
                  <span class="dimension-value__number">{shape()[0].toLocaleString()}</span>
                </div>
                <span class="dimension-display__separator">x</span>
                <div class="dimension-value">
                  <span class="dimension-value__label">Timepoints</span>
                  <span class="dimension-value__number">{shape()[1].toLocaleString()}</span>
                </div>
              </div>
            </div>

            <Show when={shape()[0] > shape()[1]}>
              <div class="warning-card">
                <span class="warning-card__icon">!</span>
                <span>
                  This array has more rows than columns. If your data has more cells than
                  timepoints, this is correct.
                </span>
              </div>
            </Show>

            <div class="dimension-actions">
              <button class="btn-secondary" onClick={() => setSwapped(!swapped())}>
                Swap Dimensions
              </button>
              <button class="btn-primary" onClick={() => setDimensionsConfirmed(true)}>
                Confirm
              </button>
            </div>
          </>
        )}
      </Show>
    </div>
  );
}
