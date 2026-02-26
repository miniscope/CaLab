/**
 * Post-submission confirmation card.
 * Generic over submission type — app provides a renderParams function
 * for displaying submission-specific parameters.
 */

import { createSignal, Show } from 'solid-js';
import type { JSX } from 'solid-js';
import type { BaseSubmission } from '@calab/community';
import './styles/community.css';

export interface SubmissionSummaryProps<T extends BaseSubmission> {
  submission: T;
  renderParams: (submission: T) => JSX.Element;
  onDismiss: () => void;
  onDelete: (id: string) => Promise<void>;
}

export function SubmissionSummary<T extends BaseSubmission>(props: SubmissionSummaryProps<T>) {
  const [deleting, setDeleting] = createSignal(false);
  const [deleteError, setDeleteError] = createSignal<string | null>(null);

  async function handleDelete(): Promise<void> {
    setDeleting(true);
    setDeleteError(null);
    try {
      await props.onDelete(props.submission.id);
      props.onDismiss();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div class="submission-summary">
      <h4 class="submission-summary__title">Submission Successful</h4>
      <p class="submission-summary__confirmation">
        Your submission is now visible to the community.
      </p>

      <div class="submission-summary__params">{props.renderParams(props.submission)}</div>

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
