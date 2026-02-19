import { createSignal, onCleanup, Show } from 'solid-js';
import {
  buildFeedbackUrl,
  buildFeatureRequestUrl,
  buildBugReportUrl,
} from '../../lib/community/github-issue-url.ts';
import '../../styles/feedback-menu.css';

const MENU_ITEMS = [
  { label: 'General Feedback', desc: 'Share thoughts or suggestions', url: buildFeedbackUrl },
  { label: 'Feature Request', desc: 'Suggest a new feature', url: buildFeatureRequestUrl },
  { label: 'Bug Report', desc: 'Report something broken', url: buildBugReportUrl },
] as const;

export function FeedbackMenu() {
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
    <div class="feedback-menu" data-tutorial="feedback-menu" ref={containerRef}>
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
              href={item.url()}
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
