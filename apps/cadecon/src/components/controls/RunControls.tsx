import { Show, type JSX } from 'solid-js';
import { runState } from '../../lib/iteration-store.ts';
import { startRun, pauseRun, resumeRun, stopRun, resetRun } from '../../lib/iteration-manager.ts';
import { parsedData, samplingRate } from '../../lib/data-store.ts';

export function RunControls(): JSX.Element {
  const hasData = () => !!parsedData() && !!samplingRate();

  return (
    <div class="param-panel">
      <div style="display: flex; gap: var(--space-sm); flex-wrap: wrap;">
        <Show
          when={runState() !== 'paused'}
          fallback={
            <button class="btn-primary" onClick={resumeRun}>
              Resume
            </button>
          }
        >
          <button
            class="btn-primary"
            disabled={runState() !== 'idle' || !hasData()}
            onClick={() => void startRun()}
          >
            Start
          </button>
        </Show>

        <button class="btn-secondary" disabled={runState() !== 'running'} onClick={pauseRun}>
          Pause
        </button>

        <button
          class="btn-secondary"
          disabled={runState() !== 'running' && runState() !== 'paused'}
          onClick={stopRun}
        >
          Stop
        </button>

        <button
          class="btn-secondary"
          disabled={runState() !== 'complete' && runState() !== 'stopping'}
          onClick={resetRun}
        >
          Reset
        </button>
      </div>
    </div>
  );
}
