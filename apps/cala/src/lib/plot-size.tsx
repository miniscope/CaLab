import { createSignal, onCleanup, onMount, type JSX } from 'solid-js';

/**
 * One rule for every line plot in the right column: the plot is as tall as its
 * width over PLOT_ASPECT (3.5:1), within PLOT_MIN_PX..PLOT_MAX_PX. A stretched
 * vertical axis is harder to read than a wide, shallow one, so spare panel
 * height stays empty rather than going to the plot. At the column's usual
 * 450-650 px this gives 140-186 px; the cap only bites on very wide columns.
 */
export const PLOT_ASPECT = 3.5;
export const PLOT_MIN_PX = 140;
export const PLOT_MAX_PX = 260;
/** Heights are rounded to this step (a plot is rebuilt per height), px. */
const PLOT_STEP_PX = 4;

/** The plot height for `width` CSS px; `max` raises the cap (the expanded History). */
export function plotHeight(width: number, max: number = PLOT_MAX_PX): number {
  if (!(width > 0)) return PLOT_MIN_PX;
  const h = Math.round(width / PLOT_ASPECT / PLOT_STEP_PX) * PLOT_STEP_PX;
  return Math.max(PLOT_MIN_PX, Math.min(max, h));
}

/**
 * A box that tells its child the plot height for the box's own width. The box
 * is not stretched: it is as tall as its content.
 */
export function AspectPlot(props: {
  children: (height: () => number) => JSX.Element;
  max?: number;
  class?: string;
}): JSX.Element {
  let box!: HTMLDivElement;
  const [width, setWidth] = createSignal(0);
  onMount(() => {
    setWidth(box.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      // Hidden (a tab not shown): keep the last width.
      if (box.clientWidth > 0) setWidth(box.clientWidth);
    });
    ro.observe(box);
    onCleanup(() => ro.disconnect());
  });
  const height = () => plotHeight(width(), props.max);
  return (
    <div ref={box} class={props.class} style={{ 'min-width': 0 }}>
      {props.children(height)}
    </div>
  );
}
