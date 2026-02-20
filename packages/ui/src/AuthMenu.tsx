import type { JSX } from 'solid-js';
import { Show, createSignal, onCleanup } from 'solid-js';

export interface AuthMenuProps {
  userEmail: string | null;
  loading: boolean;
  enabled: boolean;
  onSignOut: () => void;
  signInForm?: JSX.Element;
}

export function AuthMenu(props: AuthMenuProps) {
  const [open, setOpen] = createSignal(false);
  let containerRef!: HTMLDivElement;

  const close = () => setOpen(false);

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };

  const handleClickOutside = (e: MouseEvent) => {
    if (!containerRef.contains(e.target as Node)) close();
  };

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

  const initial = () => {
    const email = props.userEmail;
    return email ? email.charAt(0).toUpperCase() : '?';
  };

  return (
    <Show when={props.enabled}>
      <Show when={!props.loading} fallback={<div class="auth-menu__placeholder" />}>
        <div class="auth-menu" ref={containerRef}>
          <Show
            when={props.userEmail}
            fallback={
              <button
                class="btn-secondary btn-small"
                aria-expanded={open()}
                aria-haspopup="true"
                onClick={toggle}
              >
                Sign In
              </button>
            }
          >
            <button
              class="auth-menu__avatar"
              aria-expanded={open()}
              aria-haspopup="true"
              onClick={toggle}
            >
              {initial()}
            </button>
          </Show>
          <Show when={open()}>
            <div class="auth-menu__dropdown" role="menu">
              <Show
                when={props.userEmail}
                fallback={<div class="auth-menu__form">{props.signInForm}</div>}
              >
                <div class="auth-menu__email">{props.userEmail}</div>
                <button
                  class="auth-menu__sign-out"
                  role="menuitem"
                  onClick={() => {
                    props.onSignOut();
                    close();
                  }}
                >
                  Sign Out
                </button>
              </Show>
            </div>
          </Show>
        </div>
      </Show>
    </Show>
  );
}
