/**
 * Inline privacy notice with expandable data flow details.
 * Shows a brief privacy message (always visible) and a
 * "Learn more" toggle with detailed explanation.
 *
 * Content is slot-driven: each app provides its own shared/retained item lists.
 */

import { createSignal, Show } from 'solid-js';
import type { JSX } from 'solid-js';
import './styles/community.css';

export interface PrivacyNoticeProps {
  /** Describes what data IS shared (transmitted to the server). */
  sharedItems: JSX.Element;
  /** Describes what data is NOT shared (stays in the browser). */
  retainedItems: JSX.Element;
}

export function PrivacyNotice(props: PrivacyNoticeProps) {
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
          <p>{props.sharedItems}</p>
          <p>{props.retainedItems}</p>
          <p>
            Submissions are stored in a Supabase database. You can delete your own submissions at
            any time.
          </p>
        </div>
      </Show>
    </div>
  );
}
