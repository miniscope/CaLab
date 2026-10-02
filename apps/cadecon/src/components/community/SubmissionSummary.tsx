/**
 * CaDecon SubmissionSummary — wraps the shared SubmissionSummary with CaDecon rendering.
 */

import { SubmissionSummary as SharedSubmissionSummary } from '@calab/ui';
import { deleteSubmission } from '../../lib/community/index.ts';
import type { CadeconSubmission } from '../../lib/community/index.ts';

interface SubmissionSummaryProps {
  submission: CadeconSubmission;
  onDismiss: () => void;
  onDelete: () => void;
}

export function SubmissionSummary(props: SubmissionSummaryProps) {
  // Extracting the async handler out of the JSX props avoids the
  // `solid/reactivity` lint rule flagging an inline async arrow as a
  // tracked scope — it isn't a tracked scope, but the rule can't tell
  // once the handler is bound to a prop named `onDelete`.
  async function handleDelete(id: string): Promise<void> {
    await deleteSubmission(id);
    props.onDelete();
  }

  return (
    <SharedSubmissionSummary
      submission={props.submission}
      renderParams={(s: CadeconSubmission) => (
        <>
          <span>tau_rise: {(s.tau_rise * 1000).toFixed(1)}ms</span>
          <span>tau_decay: {(s.tau_decay * 1000).toFixed(1)}ms</span>
          <span>iterations: {s.num_iterations}</span>
          <span>{s.converged ? 'converged' : 'stopped'}</span>
        </>
      )}
      onDismiss={props.onDismiss}
      onDelete={handleDelete}
    />
  );
}
