import { Show, type JSX } from 'solid-js';
import { DashboardPanel } from '@calab/ui';

/**
 * A panel of the right-hand column, in a tab of its own: a header (title, free content, actions)
 * over a body that is always shown.
 */
export function SidePanel(props: {
  id: string;
  title: JSX.Element;
  class?: string;
  head?: JSX.Element;
  actions?: JSX.Element;
  children: JSX.Element;
}): JSX.Element {
  return (
    <DashboardPanel
      id={props.id}
      variant="data"
      class={`cala-side-panel${props.class ? ` ${props.class}` : ''}`}
    >
      <div class="cala-side-panel__head">
        <h2 class="panel-label cala-side-panel__title">{props.title}</h2>
        <Show when={props.head}>
          <div class="cala-side-panel__extra">{props.head}</div>
        </Show>
        <Show when={props.actions}>
          <div class="cala-side-panel__actions">{props.actions}</div>
        </Show>
      </div>
      <div id={`${props.id}-body`} class="cala-side-panel__body">
        {props.children}
      </div>
    </DashboardPanel>
  );
}
