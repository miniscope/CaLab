import { Show, type JSX } from 'solid-js';
import {
  runState,
  currentIteration,
  progress,
  runPhase,
  type RunState,
  type RunPhase,
} from '../../lib/iteration-store.ts';
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

function phaseLabel(phase: RunPhase): string | null {
  switch (phase) {
    case 'inference':
      return 'Trace inference';
    case 'kernel-update':
      return 'Kernel estimation';
    case 'merge':
      return 'Merging subsets';
    case 'finalization':
      return 'Finalizing all cells';
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
        <Show when={phaseLabel(runPhase())}>
          {(label) => <p class="progress-bar__phase">{label()}</p>}
        </Show>
        <Show when={statusLabel(runState())}>
          {(label) => <p class="progress-bar__status">{label()}</p>}
        </Show>
      </div>
    </Show>
  );
}
