import { Show, type JSX } from 'solid-js';

/** 'stopping' looks like 'idle': no pulse and no fill modifier. */
export type ProgressState = 'idle' | 'running' | 'paused' | 'complete' | 'error' | 'stopping';

export interface ProgressBarProps {
  /** 0..1, clamped. */
  fraction: number;
  state?: ProgressState;
  /** Omitted: no label row. */
  label?: JSX.Element;
  /** Percent in the label row (default true). */
  showPct?: boolean;
  phase?: string | null;
  status?: string | null;
  class?: string;
  testid?: string;
  'aria-label'?: string;
}

export function ProgressBar(p: ProgressBarProps): JSX.Element {
  const pct = () => Math.round(Math.min(1, Math.max(0, p.fraction || 0)) * 100);
  const state = () => p.state ?? 'idle';
  return (
    <div class={`progress-bar${p.class ? ' ' + p.class : ''}`} data-testid={p.testid}>
      <Show when={p.label !== undefined}>
        <div class="progress-bar__label">
          <span>{p.label}</span>
          <Show when={p.showPct ?? true}>
            <span class="progress-bar__pct">{pct()}%</span>
          </Show>
        </div>
      </Show>
      <div
        class="progress-bar__track"
        classList={{ 'progress-bar__track--running': state() === 'running' }}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct()}
        aria-label={p['aria-label']}
      >
        <div
          class="progress-bar__fill"
          classList={{
            'progress-bar__fill--paused': state() === 'paused',
            'progress-bar__fill--complete': state() === 'complete',
            'progress-bar__fill--error': state() === 'error',
          }}
          style={{ width: `${pct()}%` }}
        />
      </div>
      <Show when={p.phase}>{(t) => <p class="progress-bar__phase">{t()}</p>}</Show>
      <Show when={p.status}>{(t) => <p class="progress-bar__status">{t()}</p>}</Show>
    </div>
  );
}
