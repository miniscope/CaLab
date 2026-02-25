import { Show, type JSX } from 'solid-js';
import { runState, currentIteration, progress } from '../../lib/iteration-store.ts';
import { maxIterations } from '../../lib/algorithm-store.ts';

export function ProgressBar(): JSX.Element {
  const state = () => runState();
  const pct = () => Math.round(progress() * 100);

  return (
    <Show when={state() !== 'idle'}>
      <div class="progress-bar">
        <div class="progress-bar__label">
          <span>
            Iteration {currentIteration()} of {maxIterations()}
          </span>
          <span class="progress-bar__pct">{pct()}%</span>
        </div>
        <div class="progress-bar__track">
          <div
            class="progress-bar__fill"
            classList={{
              'progress-bar__fill--paused': state() === 'paused',
              'progress-bar__fill--complete': state() === 'complete',
            }}
            style={{ width: `${pct()}%` }}
          />
        </div>
        <Show when={state() === 'paused'}>
          <p class="progress-bar__status">Paused</p>
        </Show>
        <Show when={state() === 'stopping'}>
          <p class="progress-bar__status">Stopping...</p>
        </Show>
        <Show when={state() === 'complete'}>
          <p class="progress-bar__status">Complete</p>
        </Show>
      </div>
    </Show>
  );
}
