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
            <button class="btn-primary btn-icon" onClick={resumeRun}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
                <polygon points="2,0 12,6 2,12" />
              </svg>
              Resume
            </button>
          }
        >
          <button
            class="btn-primary btn-icon"
            disabled={runState() !== 'idle' || !hasData()}
            onClick={() => void startRun()}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
              <polygon points="2,0 12,6 2,12" />
            </svg>
            Start
          </button>
        </Show>

        <button
          class="btn-secondary btn-icon"
          disabled={runState() !== 'running'}
          onClick={pauseRun}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
            <rect x="1" y="1" width="3.5" height="10" rx="0.5" />
            <rect x="7.5" y="1" width="3.5" height="10" rx="0.5" />
          </svg>
          Pause
        </button>

        <button
          class="btn-secondary btn-icon"
          disabled={runState() !== 'running' && runState() !== 'paused'}
          onClick={stopRun}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
            <rect x="1" y="1" width="10" height="10" rx="1" />
          </svg>
          Stop
        </button>

        <button
          class="btn-secondary btn-icon"
          disabled={runState() !== 'complete' && runState() !== 'stopping'}
          onClick={resetRun}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M1 1v3.5h3.5" />
            <path d="M10.2 4.5A4.5 4.5 0 0 0 2.1 2.8L1 4.5" />
            <path d="M6 11a5 5 0 0 0 4.2-6.5" />
          </svg>
          Reset
        </button>
      </div>
    </div>
  );
}
