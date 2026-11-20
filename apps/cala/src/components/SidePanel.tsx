import { createSignal, Show, type JSX } from 'solid-js';
import { DashboardPanel } from '@calab/ui';

/**
 * A panel of the right-hand column: a header (chevron, title, free content,
 * actions) over a body. Collapsing hides the body, or, with `alwaysShown`,
 * only tells the owner (the Run panel folds its metric rows away and keeps the
 * pass bars). `fixed`: no chevron, always open (a panel that has a tab of its own).
 */
export function SidePanel(props: {
  id: string;
  title: JSX.Element;
  class?: string;
  /** Controlled open state (else internal, starting at `defaultOpen ?? true`). */
  open?: boolean;
  defaultOpen?: boolean;
  onToggle?: (open: boolean) => void;
  toggleLabel?: (open: boolean) => string;
  head?: JSX.Element;
  actions?: JSX.Element;
  alwaysShown?: boolean;
  /** Not collapsible: the header has no toggle and the body is always shown. */
  fixed?: boolean;
  children: JSX.Element;
}): JSX.Element {
  const [inner, setInner] = createSignal(props.defaultOpen ?? true);
  const open = () => props.fixed === true || (props.open ?? inner());
  const toggle = () => {
    const next = !open();
    setInner(next);
    props.onToggle?.(next);
  };
  const label = () =>
    props.toggleLabel?.(open()) ?? (open() ? 'Collapse the panel' : 'Expand the panel');
  return (
    <DashboardPanel
      id={props.id}
      variant="data"
      class={`cala-side-panel${open() ? '' : ' cala-side-panel--closed'}${props.fixed ? ' cala-side-panel--fixed' : ''}${props.class ? ` ${props.class}` : ''}`}
    >
      <div class="cala-side-panel__head">
        <Show
          when={!props.fixed}
          fallback={<h2 class="panel-label cala-side-panel__title">{props.title}</h2>}
        >
          <button
            type="button"
            class="cala-side-panel__toggle"
            aria-expanded={open()}
            aria-controls={`${props.id}-body`}
            aria-label={label()}
            title={label()}
            onClick={toggle}
          >
            <span class="cala-side-panel__chev" aria-hidden="true">
              <svg
                class="cala-side-panel__chev-icon"
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M3 4.5L6 7.5L9 4.5"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </span>
            <h2 class="panel-label cala-side-panel__title">{props.title}</h2>
          </button>
        </Show>
        <Show when={props.head}>
          <div class="cala-side-panel__extra">{props.head}</div>
        </Show>
        <Show when={props.actions}>
          <div class="cala-side-panel__actions">{props.actions}</div>
        </Show>
      </div>
      <div
        id={`${props.id}-body`}
        class="cala-side-panel__body"
        hidden={!props.alwaysShown && !open()}
      >
        {props.children}
      </div>
    </DashboardPanel>
  );
}
