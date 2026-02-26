/** Iteration history scrubber — range slider to navigate between solver iterations. */

import { Show, type JSX } from 'solid-js';
import { iterationHistory } from '../../lib/iteration-store.ts';
import { viewedIteration, setViewedIteration } from '../../lib/viz-store.ts';
import '../../styles/iteration-scrubber.css';

export function IterationScrubber(): JSX.Element {
  const history = () => iterationHistory();
  const maxIter = () => {
    const h = history();
    return h.length > 0 ? h[h.length - 1].iteration : 0;
  };

  const effectiveValue = () => viewedIteration() ?? maxIter();
  const isLatest = () => viewedIteration() == null;

  const handleInput = (e: Event) => {
    const val = parseInt((e.target as HTMLInputElement).value, 10);
    if (val >= maxIter()) {
      setViewedIteration(null); // snap to latest
    } else {
      setViewedIteration(val);
    }
  };

  const goLatest = () => setViewedIteration(null);

  return (
    <Show when={history().length > 1}>
      <div class="iteration-scrubber" classList={{ 'iteration-scrubber--past': !isLatest() }}>
        <label class="iteration-scrubber__label">Iteration:</label>
        <input
          class="iteration-scrubber__slider"
          type="range"
          min={1}
          max={maxIter()}
          value={effectiveValue()}
          onInput={handleInput}
        />
        <span class="iteration-scrubber__value">
          {effectiveValue()} / {maxIter()}
        </span>
        <button
          class="iteration-scrubber__latest"
          classList={{ 'iteration-scrubber__latest--active': isLatest() }}
          onClick={goLatest}
        >
          Latest
        </button>
      </div>
    </Show>
  );
}
