/**
 * CaTune SubmissionSummary — wraps the shared SubmissionSummary with CaTune rendering.
 */

import { SubmissionSummary as SharedSubmissionSummary } from '@calab/ui';
import { deleteSubmission } from '../../lib/community/index.ts';
import type { CatuneSubmission } from '../../lib/community/index.ts';

interface SubmissionSummaryProps {
  submission: CatuneSubmission;
  onDismiss: () => void;
  onDelete: () => void;
}

export function SubmissionSummary(props: SubmissionSummaryProps) {
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
      onDelete={async (id: string) => {
        await deleteSubmission(id);
        props.onDelete();
      }}
    />
  );
}
