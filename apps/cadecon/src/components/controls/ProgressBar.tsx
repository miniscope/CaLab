import { Show, type JSX } from 'solid-js';
import { runState, currentIteration, progress } from '../../lib/iteration-store.ts';
import type { RunState } from '../../lib/iteration-store.ts';
import { maxIterations } from '../../lib/algorithm-store.ts';

function statusLabel(state: RunState): string | null {
  switch (state) {
    case 'paused':
      return 'Paused';
    case 'stopping':
      return 'Stopping...';
    case 'complete':
      return 'Complete';
    default:
      return null;
  }
}

export function ProgressBar(): JSX.Element {
  const pct = () => Math.round(progress() * 100);

  return (
    <Show when={runState() !== 'idle'}>
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
              'progress-bar__fill--paused': runState() === 'paused',
              'progress-bar__fill--complete': runState() === 'complete',
            }}
            style={{ width: `${pct()}%` }}
          />
        </div>
        <Show when={statusLabel(runState())}>
          {(label) => <p class="progress-bar__status">{label()}</p>}
        </Show>
      </div>
    </Show>
  );
}
