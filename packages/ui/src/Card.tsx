import type { JSX } from 'solid-js';

export interface CardProps {
  children: JSX.Element;
  class?: string;
  height?: number;
  resizable?: boolean;
  minHeight?: number;
  maxHeight?: number;
  onResize?: (newHeight: number) => void;
  onClick?: (e: MouseEvent) => void;
  onMouseEnter?: (e: MouseEvent) => void;
  onMouseLeave?: (e: MouseEvent) => void;
  'data-tutorial'?: string;
  ref?: (el: HTMLElement) => void;
  [key: `data-${string}`]: string | number | undefined;
}

export function Card(props: CardProps) {
  const handleResizeStart = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const startHeight = props.height ?? 0;
    const min = props.minHeight ?? 200;
    const max = props.maxHeight ?? 800;

    const onMove = (ev: MouseEvent) => {
      ev.preventDefault();
      const delta = ev.clientY - startY;
      props.onResize?.(Math.max(min, Math.min(max, startHeight + delta)));
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  return (
    <div
      class={`calab-card${props.class ? ` ${props.class}` : ''}`}
      style={props.height != null ? { height: `${props.height}px` } : undefined}
      onClick={props.onClick}
      onMouseEnter={props.onMouseEnter}
      onMouseLeave={props.onMouseLeave}
      data-tutorial={props['data-tutorial']}
      ref={props.ref}
      {...spreadDataAttrs(props)}
    >
      {props.children}
      {props.resizable && <div class="calab-card__resize-handle" onMouseDown={handleResizeStart} />}
    </div>
  );
}

/** Collect data-* attributes (excluding data-tutorial which is handled explicitly). */
function spreadDataAttrs(props: CardProps): Record<string, string | number | undefined> {
  const attrs: Record<string, string | number | undefined> = {};
  for (const key of Object.keys(props)) {
    if (key.startsWith('data-') && key !== 'data-tutorial') {
      attrs[key] = (props as unknown as Record<string, unknown>)[key] as
        | string
        | number
        | undefined;
    }
  }
  return attrs;
}
