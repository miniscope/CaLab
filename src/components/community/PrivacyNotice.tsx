/**
 * Inline privacy notice with expandable data flow details.
 * Shows a brief privacy message (always visible) and a
 * "Learn more" toggle with detailed explanation of what
 * data is and is not transmitted.
 */

import { createSignal, Show } from 'solid-js';

export function PrivacyNotice() {
  const [expanded, setExpanded] = createSignal(false);

  return (
    <div class="privacy-notice">
      <p class="privacy-notice__message">
        <span class="privacy-notice__icon" aria-hidden="true">
          &#x1F6E1;
        </span>{' '}
        Only parameters and metadata are shared &mdash; your traces never leave your browser.
      </p>
      <button
        class="privacy-notice__toggle"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded()}
      >
        {expanded() ? 'Hide details' : 'Learn more'}
      </button>
      <Show when={expanded()}>
        <div class="privacy-notice__details">
          <p>
            When you submit, CaTune sends only: parameter values (tau_rise, tau_decay, lambda), AR2
            coefficients, sampling rate, your experimental metadata (indicator, species, brain
            region), and a dataset fingerprint for duplicate detection.
          </p>
          <p>
            Your raw fluorescence traces, deconvolved activity, and any file data remain entirely in
            your browser's memory. No trace data is ever transmitted to any server.
          </p>
          <p>
            Submissions are stored in a Supabase database. You can delete your own submissions at
            any time.
          </p>
        </div>
      </Show>
    </div>
  );
}
