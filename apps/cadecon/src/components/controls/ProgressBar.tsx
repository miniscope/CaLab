import { Show, type JSX } from 'solid-js';
import { ProgressBar as SharedProgressBar } from '@calab/ui';
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
    case 'error':
      return 'Failed';
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
  return (
    <Show when={runState() !== 'idle'}>
      <SharedProgressBar
        fraction={progress()}
        state={runState()}
        label={
          <>
            Iteration {currentIteration()} of {maxIterations()}
          </>
        }
        phase={phaseLabel(runPhase())}
        status={statusLabel(runState())}
        aria-label="Run progress"
      />
    </Show>
  );
}
