import type { JSX } from 'solid-js';
import { QC_STATUS_LABEL, type QcStatus } from '../lib/qc-view.ts';

/** Colour of a QC status on the light panel (status tokens; unmeasured is the neutral mark). */
export const QC_STATUS_COLOR: Record<QcStatus, string> = {
  pass: 'var(--status-ok)',
  fail: 'var(--status-critical)',
  unmeasured: 'var(--mark-neutral)',
};

/** One status mark: a dot (pass), a diamond (fail) or a hollow ring (not measured), with its label for assistive tech. */
export function QcDot(props: { status: QcStatus; title?: string }): JSX.Element {
  return (
    <span
      class={`cala-qc-dot cala-qc-dot--${props.status}`}
      role="img"
      aria-label={QC_STATUS_LABEL[props.status]}
      title={props.title ?? QC_STATUS_LABEL[props.status]}
      data-status={props.status}
    />
  );
}
