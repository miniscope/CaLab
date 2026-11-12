/**
 * Width of the field-of-view column: the image is sized by the window's
 * height (as large as fits), and the rest of the width is the right-hand
 * column. Narrow or portrait windows stack the column under the image.
 */
import { createSignal, onCleanup, onMount, type Accessor } from 'solid-js';

/** The right-hand column never gets narrower than this (CSS px). */
export const SIDE_MIN_PX = 440;
/** Below this window width (or in portrait), the layout stacks. */
export const NARROW_BELOW_PX = 1000;
/** Height the FOV panel spends outside the image (toolbar, padding), CSS px. */
export const FOV_CHROME_V_PX = 58;
/** Width the FOV panel spends outside the image (padding, borders), CSS px. */
export const FOV_CHROME_H_PX = 18;
/** Gap between the two columns, CSS px. */
export const COLUMN_GAP_PX = 8;

export interface FovLayout {
  narrow: boolean;
  /** Width of the FOV column (wide layout), CSS px. */
  fovWidth: number;
}

/** Layout for a main area `width x height` showing an `imageWidth x imageHeight` recording. */
export function fovLayout(
  width: number,
  height: number,
  imageWidth: number,
  imageHeight: number,
): FovLayout {
  const aspect = imageWidth > 0 && imageHeight > 0 ? imageWidth / imageHeight : 1;
  if (width < NARROW_BELOW_PX || height > width) return { narrow: true, fovWidth: width };
  const byHeight = Math.max(0, height - FOV_CHROME_V_PX) * aspect + FOV_CHROME_H_PX;
  const byWidth = width - SIDE_MIN_PX - COLUMN_GAP_PX;
  return { narrow: false, fovWidth: Math.floor(Math.max(0, Math.min(byHeight, byWidth))) };
}

/** `fovLayout` of an element's content box, kept current with a ResizeObserver. */
export function createFovLayout(
  el: () => HTMLElement | undefined,
  image: () => { width: number; height: number },
): Accessor<FovLayout> {
  const [layout, setLayout] = createSignal<FovLayout>(
    fovLayout(window.innerWidth, window.innerHeight, image().width, image().height),
  );
  onMount(() => {
    const node = el();
    if (!node) return;
    const update = () => {
      const r = node.getBoundingClientRect();
      // The padding of `.cala-main` is part of the box but not of the columns.
      const cs = getComputedStyle(node);
      const w = r.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      // In the stacked layout the box grows with its content: use the window.
      const h =
        Math.min(r.height, window.innerHeight - r.top) -
        parseFloat(cs.paddingTop) -
        parseFloat(cs.paddingBottom);
      const next = fovLayout(w, h, image().width, image().height);
      const cur = layout();
      if (next.narrow !== cur.narrow || next.fovWidth !== cur.fovWidth) setLayout(next);
    };
    update();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    ro?.observe(node);
    window.addEventListener('resize', update);
    onCleanup(() => {
      ro?.disconnect();
      window.removeEventListener('resize', update);
    });
  });
  return layout;
}
