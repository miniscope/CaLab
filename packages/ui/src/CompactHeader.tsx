import type { JSX } from 'solid-js';
import { Show } from 'solid-js';

export interface CompactHeaderProps {
  title: string;
  version?: string;
  info?: JSX.Element;
  actions?: JSX.Element;
  'data-tutorial'?: string;
}

export function CompactHeader(props: CompactHeaderProps) {
  return (
    <header class="compact-header" data-tutorial={props['data-tutorial']}>
      <div class="compact-header__brand">
        <h1 class="compact-header__title">{props.title}</h1>
        <Show when={props.version}>
          <span class="compact-header__version">{props.version}</span>
        </Show>
      </div>
      <Show when={props.info}>
        <div class="compact-header__info">{props.info}</div>
      </Show>
      <Show when={props.actions}>
        <div class="compact-header__actions">{props.actions}</div>
      </Show>
    </header>
  );
}
