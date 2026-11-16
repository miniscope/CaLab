import { onCleanup, onMount, type JSX } from 'solid-js';

interface Props {
  title: string;
  onClose: () => void;
  children: JSX.Element;
}

/** Right-hand detail drawer: Escape closes, focus moves in and returns on close. */
export function Drawer(props: Props): JSX.Element {
  let closeBtn!: HTMLButtonElement;
  const opener = document.activeElement as HTMLElement | null;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') props.onClose();
  };
  onMount(() => {
    closeBtn.focus();
    document.addEventListener('keydown', onKey);
  });
  onCleanup(() => {
    document.removeEventListener('keydown', onKey);
    opener?.focus?.();
  });
  return (
    <div class="drawer-scrim" onClick={() => props.onClose()}>
      <aside
        class="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        onClick={(e) => e.stopPropagation()}
      >
        <header class="drawer__head">
          <h3>{props.title}</h3>
          <button ref={closeBtn} class="btn-secondary" onClick={() => props.onClose()}>
            Close
          </button>
        </header>
        <div class="drawer__body">{props.children}</div>
      </aside>
    </div>
  );
}
