import { Show, type JSX } from 'solid-js';
import { severityLabel, type BoundaryFlag } from '../lib/boundary-flags.ts';

const CLASS = { ok: 'pass', warning: 'warn', failed: 'fail' } as const;

/** The tooltip of a boundary flag: its reason, what to do, and every judged check that is not ok. */
export function boundaryTooltip(f: BoundaryFlag): string {
  const lines = [
    `${severityLabel(f.severity, f.pending)} (session ${f.index + 1} start).`,
    f.reason,
  ];
  if (f.suggestion) lines.push(f.suggestion);
  return lines.join('\n');
}

/**
 * A session-boundary health badge (`boundary-flags.ts`): ok, warning or
 * failed, with the reason as its tooltip. `onSeparate`: a failed boundary
 * offers to re-plan the chain's sessions as Separate runs (never automatic).
 */
export function BoundaryBadge(props: { flag: BoundaryFlag; onSeparate?: () => void }): JSX.Element {
  const f = () => props.flag;
  return (
    <span class="cala-boundary-flag">
      <span
        class={`cala-qc-badge cala-qc-badge--${f().pending && f().severity === 'ok' ? 'pending' : CLASS[f().severity]}`}
        data-testid="boundary-badge"
        data-severity={f().severity}
        title={boundaryTooltip(f())}
        role="status"
      >
        {severityLabel(f().severity, f().pending)}
      </span>
      <Show when={f().severity === 'failed' && props.onSeparate}>
        {' '}
        <button
          type="button"
          class="btn-secondary btn-small"
          data-testid="replan-separate"
          title="Put this chain's sessions into the run plan as Separate runs (a library per session). Nothing runs until you start the plan."
          onClick={() => props.onSeparate?.()}
        >
          Re-plan as Separate
        </button>
      </Show>
    </span>
  );
}
