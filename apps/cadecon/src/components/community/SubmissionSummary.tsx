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
      onDelete={async (id: string) => {
        await deleteSubmission(id);
        props.onDelete();
      }}
    />
  );
}
