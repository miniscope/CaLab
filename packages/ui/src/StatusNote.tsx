import type { JSX } from 'solid-js';
import { Icon } from './Icon.tsx';
import { STATUS_ICON, type StatusTone } from './tones.ts';

export interface StatusNoteProps {
  /** The message: one sentence, in the status ink. */
  children: JSX.Element;
  /** Status tone (default warning); its icon always comes with the text. */
  tone?: StatusTone;
  /** `alert` for an error the user must act on, `status` for a live notice; none for a static one. */
  role?: 'alert' | 'status';
  class?: string;
  testid?: string;
}

/**
 * A status message as a block: the pale status tint, the status icon and the text in the
 * status ink. For a sentence that does not fit a Badge chip; colour never carries the
 * meaning alone, the icon and the words do.
 */
export function StatusNote(p: StatusNoteProps): JSX.Element {
  const tone = () => p.tone ?? 'warning';
  return (
    <p
      class={`status-note status-note--${tone()}${p.class ? ' ' + p.class : ''}`}
      role={p.role}
      data-testid={p.testid}
    >
      <Icon name={STATUS_ICON[tone()]} size={14} />
      <span class="status-note__text">{p.children}</span>
    </p>
  );
}
