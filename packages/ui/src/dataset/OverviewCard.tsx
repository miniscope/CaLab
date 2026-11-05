/**
 * Frame for the dataset-overview cards: title, optional "?" help popover,
 * optional header extras, a body that fills the remaining height, and a
 * footer line for stats. Also exports the shared sizing and brush helpers.
 */

import { createSignal, onCleanup, onMount, Show, type Accessor, type JSX } from 'solid-js';

export interface OverviewCardProps {
  title: string;
  /** Help text shown in a popover from the "?" button. */
  help?: JSX.Element;
  headerExtra?: JSX.Element;
  footer?: JSX.Element;
  class?: string;
  children: JSX.Element;
  'data-testid'?: string;
}

export function OverviewCard(props: OverviewCardProps): JSX.Element {
  const [helpOpen, setHelpOpen] = createSignal(false);
  return (
    <section
      class={`ov-card ${props.class ?? ''}`}
      data-testid={props['data-testid']}
      aria-label={props.title}
    >
      <header class="ov-card__header">
        <h3 class="ov-card__title">{props.title}</h3>
        {props.headerExtra}
        <Show when={props.help}>
          <button
            type="button"
            class="ov-card__help-btn"
            aria-label={`About ${props.title}`}
            aria-expanded={helpOpen()}
            onClick={() => setHelpOpen((v) => !v)}
          >
            ?
          </button>
        </Show>
      </header>
      <Show when={helpOpen()}>
        <div class="ov-card__help" role="note" onClick={() => setHelpOpen(false)}>
          {props.help}
        </div>
      </Show>
      <div class="ov-card__body">{props.children}</div>
      <Show when={props.footer}>
        <div class="ov-card__footer">{props.footer}</div>
      </Show>
    </section>
  );
}

/** Track an element's content size (falls back to `fallback` without ResizeObserver). */
export function createElementSize(
  el: Accessor<HTMLElement | undefined>,
  fallback: { width: number; height: number } = { width: 320, height: 130 },
): Accessor<{ width: number; height: number }> {
  const [size, setSize] = createSignal(fallback);
  onMount(() => {
    const node = el();
    if (!node || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const r = node.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        setSize({ width: Math.floor(r.width), height: Math.floor(r.height) });
      }
    };
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    measure();
    onCleanup(() => ro.disconnect());
  });
  return size;
}

export interface BrushState {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/**
 * Pointer handling shared by the cards: a drag past 4 px is a brush
 * (`onBrush` with the pixel rectangle, relative to the SVG), a short press
 * is a click (`onClick` with the point).
 */
export function createBrush(opts: {
  onBrush(rect: BrushState): void;
  onClick?(x: number, y: number): void;
  /** Brush only along x (the rectangle spans the full height). */
  xOnly?: boolean;
}) {
  const [active, setActive] = createSignal<BrushState | null>(null);
  let start: { x: number; y: number } | null = null;
  const local = (e: PointerEvent) => {
    const r = (e.currentTarget as Element).getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const handlers = {
    onPointerDown(e: PointerEvent) {
      if (e.button !== 0) return;
      start = local(e);
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    },
    onPointerMove(e: PointerEvent) {
      if (!start) return;
      const p = local(e);
      if (Math.abs(p.x - start.x) < 4 && Math.abs(p.y - start.y) < 4) return;
      setActive({ x0: start.x, x1: p.x, y0: start.y, y1: p.y });
    },
    onPointerUp(e: PointerEvent) {
      if (!start) return;
      const b = active();
      const s = start;
      start = null;
      setActive(null);
      if (b) opts.onBrush(b);
      else opts.onClick?.(s.x, s.y);
      void e;
    },
    onPointerCancel() {
      start = null;
      setActive(null);
    },
  };
  return { active, handlers };
}
