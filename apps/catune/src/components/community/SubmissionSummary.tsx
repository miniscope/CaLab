/**
 * CaTune SubmissionSummary — wraps the shared SubmissionSummary with CaTune rendering.
 */

import { SubmissionSummary as SharedSubmissionSummary } from '@calab/community-ui';
import { deleteSubmission } from '../../lib/community/index.ts';
import type { CatuneSubmission } from '../../lib/community/index.ts';

interface SubmissionSummaryProps {
  submission: CatuneSubmission;
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
      renderParams={(s: CatuneSubmission) => (
        <>
          <span>tau_rise: {(s.tau_rise * 1000).toFixed(1)}ms</span>
          <span>tau_decay: {(s.tau_decay * 1000).toFixed(1)}ms</span>
          <span>lambda: {s.lambda.toExponential(2)}</span>
        </>
      )}
      onDismiss={props.onDismiss}
      onDelete={handleDelete}
    />
  );
}
