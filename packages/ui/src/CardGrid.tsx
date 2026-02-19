import type { JSX } from 'solid-js';

export interface CardGridProps {
  columns?: number;
  children: JSX.Element;
  class?: string;
  'data-tutorial'?: string;
}

export function CardGrid(props: CardGridProps): JSX.Element {
  return (
    <div class={`card-grid-container${props.class ? ` ${props.class}` : ''}`}>
      <div
        class="card-grid"
        data-tutorial={props['data-tutorial']}
        style={{ '--grid-cols': props.columns ?? 2 }}
      >
        {props.children}
      </div>
    </div>
  );
}
