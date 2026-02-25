import { Show, type JSX } from 'solid-js';
import { runState } from '../../lib/iteration-store.ts';
import { startRun, pauseRun, resumeRun, stopRun, resetRun } from '../../lib/iteration-manager.ts';
import { parsedData, samplingRate } from '../../lib/data-store.ts';

export function RunControls(): JSX.Element {
  const state = () => runState();
  const hasData = () => !!parsedData() && !!samplingRate();

  return (
    <div class="param-panel">
      <div style="display: flex; gap: var(--space-sm); flex-wrap: wrap;">
        <Show
          when={state() !== 'paused'}
          fallback={
            <button class="btn-primary" onClick={resumeRun}>
              Resume
            </button>
          }
        >
          <button
            class="btn-primary"
            disabled={state() !== 'idle' || !hasData()}
            onClick={() => void startRun()}
          >
            Start
          </button>
        </Show>

        <button class="btn-secondary" disabled={state() !== 'running'} onClick={pauseRun}>
          Pause
        </button>

        <button
          class="btn-secondary"
          disabled={state() !== 'running' && state() !== 'paused'}
          onClick={stopRun}
        >
          Stop
        </button>

        <button
          class="btn-secondary"
          disabled={state() !== 'complete' && state() !== 'stopping'}
          onClick={resetRun}
        >
          Reset
        </button>
      </div>
    </div>
  );
}
