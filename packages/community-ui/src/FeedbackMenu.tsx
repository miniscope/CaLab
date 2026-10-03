/**
 * Header "Feedback" dropdown (general feedback / feature request / bug report)
 * and the plain-link variant shown in the import screen's footer. Both open
 * pre-filled GitHub issues labelled with the app id.
 */

import { createSignal, onCleanup, Show, type JSX } from 'solid-js';
import type { AppLabel } from '@calab/community';
import { buildFeedbackUrl, buildFeatureRequestUrl, buildBugReportUrl } from '@calab/community';
import './styles/feedback-menu.css';

const MENU_ITEMS = [
  {
    label: 'General Feedback',
    desc: 'Share thoughts or suggestions',
    url: buildFeedbackUrl,
  },
  {
    label: 'Feature Request',
    desc: 'Suggest a new feature',
    url: buildFeatureRequestUrl,
  },
  {
    label: 'Bug Report',
    desc: 'Report something broken',
    url: buildBugReportUrl,
  },
] as const;

export interface FeedbackMenuProps {
  /** The app's id (its build-time `__APP_ID__`), added as an issue label. */
  appId: AppLabel;
  /** `data-tutorial` anchor on the menu, for tutorials that point at it. */
  tutorialAnchor?: string;
}

export function FeedbackMenu(props: FeedbackMenuProps): JSX.Element {
  const [open, setOpen] = createSignal(false);
  let containerRef!: HTMLDivElement;

  const close = () => setOpen(false);

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };

  const handleClickOutside = (e: MouseEvent) => {
    if (!containerRef.contains(e.target as Node)) close();
  };

  // Attach/detach global listeners when menu opens/closes
  const attach = () => {
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('pointerdown', handleClickOutside);
  };
  const detach = () => {
    document.removeEventListener('keydown', handleKeyDown);
    document.removeEventListener('pointerdown', handleClickOutside);
  };

  onCleanup(detach);

  const toggle = () => {
    const next = !open();
    setOpen(next);
    if (next) attach();
    else detach();
  };

  return (
    <div class="feedback-menu" data-tutorial={props.tutorialAnchor} ref={containerRef}>
      <button
        class="btn-secondary btn-small"
        aria-expanded={open()}
        aria-haspopup="true"
        onClick={toggle}
      >
        Feedback
      </button>
      <Show when={open()}>
        <div class="feedback-menu__dropdown" role="menu">
          {MENU_ITEMS.map((item) => (
            <a
              class="feedback-menu__item"
              role="menuitem"
              href={item.url(props.appId)}
              target="_blank"
              rel="noopener noreferrer"
              onClick={close}
            >
              <span class="feedback-menu__item-label">{item.label}</span>
              <span class="feedback-menu__item-desc">{item.desc}</span>
            </a>
          ))}
        </div>
      </Show>
    </div>
  );
}

export interface ImportFeedbackLinksProps {
  /** The app's id (its build-time `__APP_ID__`), added as an issue label. */
  appId: AppLabel;
}

/** Inline feedback links for the import screen footer. */
export function ImportFeedbackLinks(props: ImportFeedbackLinksProps): JSX.Element {
  return (
    <footer class="import-feedback">
      <a href={buildFeedbackUrl(props.appId)} target="_blank" rel="noopener noreferrer">
        Feedback
      </a>
      <span class="import-feedback__sep">&middot;</span>
      <a href={buildFeatureRequestUrl(props.appId)} target="_blank" rel="noopener noreferrer">
        Feature Request
      </a>
      <span class="import-feedback__sep">&middot;</span>
      <a href={buildBugReportUrl(props.appId)} target="_blank" rel="noopener noreferrer">
        Bug Report
      </a>
    </footer>
  );
}
