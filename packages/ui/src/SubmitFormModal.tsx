/**
 * Shared modal shell for community submission forms.
 * Renders via Portal as a centered overlay with Escape key dismissal.
 * Form field content is provided via the children slot.
 */

import { onCleanup } from 'solid-js';
import type { JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import './styles/community.css';

export interface SubmitFormModalProps {
  title?: string;
  onClose: () => void;
  children: JSX.Element;
}

export function SubmitFormModal(props: SubmitFormModalProps) {
  return (
    <Portal mount={document.body}>
      <div
        class="submit-modal__backdrop"
        onClick={(e) => {
          if (e.target === e.currentTarget) props.onClose();
        }}
        ref={() => {
          const handleKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') props.onClose();
          };
          document.addEventListener('keydown', handleKey);
          onCleanup(() => document.removeEventListener('keydown', handleKey));
        }}
      >
        <div class="submit-modal__content">
          <h3 class="submit-modal__title">{props.title ?? 'Submit to Community'}</h3>
          {props.children}
        </div>
      </div>
    </Portal>
  );
}
