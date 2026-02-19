/**
 * Post-submission confirmation card.
 * Displays what was submitted and actions (close or delete the submission).
 */

import { createSignal, Show } from 'solid-js';
import { deleteSubmission } from '../../lib/community/index.ts';
import type { CommunitySubmission } from '../../lib/community/index.ts';

interface SubmissionSummaryProps {
  submission: CommunitySubmission;
  onDismiss: () => void;
  onDelete: () => void;
}

export function SubmissionSummary(props: SubmissionSummaryProps) {
  const [deleting, setDeleting] = createSignal(false);
  const [deleteError, setDeleteError] = createSignal<string | null>(null);

  const handleDelete = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteSubmission(props.submission.id);
      props.onDelete();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div class="submission-summary">
      <h4 class="submission-summary__title">Submission Successful</h4>
      <p class="submission-summary__confirmation">
        Your submission is now visible to the community.
      </p>

      <div class="submission-summary__params">
        <span>tau_rise: {(props.submission.tau_rise * 1000).toFixed(1)}ms</span>
        <span>tau_decay: {(props.submission.tau_decay * 1000).toFixed(1)}ms</span>
        <span>lambda: {props.submission.lambda.toExponential(2)}</span>
      </div>

      <div class="submission-summary__meta">
        <span>Indicator: {props.submission.indicator}</span>
        <span>Species: {props.submission.species}</span>
        <span>Brain region: {props.submission.brain_region}</span>
      </div>

      <p class="submission-summary__timestamp">
        Submitted: {new Date(props.submission.created_at).toLocaleString()}
      </p>

      <Show when={deleteError()}>
        <p class="text-error">{deleteError()}</p>
      </Show>

      <div class="submission-summary__actions">
        <button class="btn-primary btn-small" onClick={props.onDismiss}>
          Close
        </button>
        <button class="btn-secondary btn-small" onClick={handleDelete} disabled={deleting()}>
          {deleting() ? 'Deleting...' : 'Delete Submission'}
        </button>
      </div>
    </div>
  );
}
