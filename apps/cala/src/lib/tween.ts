/**
 * A number shown easing to each new value, for a figure that updates at most twice a second.
 * One short requestAnimationFrame run per new value (`TWEEN_MS`), nothing between values; with
 * motion off it is the value itself. Display only.
 */
import { createEffect, createSignal, on, onCleanup, type Accessor } from 'solid-js';

export const TWEEN_MS = 420;

/** Ease-out cubic. */
export const easeOut = (t: number): number => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;

/** Value at time `t` (ms) of a tween from `a` to `b` started at `t0`, rounded to an integer. */
export function tweenAt(a: number, b: number, t0: number, t: number, ms = TWEEN_MS): number {
  return Math.round(a + (b - a) * easeOut((t - t0) / ms));
}

/** `target()` eased (integers); null while the target is null. Call inside a component. */
export function createTween(
  target: () => number | null,
  motion: () => boolean,
): Accessor<number | null> {
  const [shown, setShown] = createSignal<number | null>(target());
  let raf = 0;
  const stop = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };
  createEffect(
    on(target, (b) => {
      stop();
      const a = shown();
      if (
        b === null ||
        a === null ||
        a === b ||
        !motion() ||
        typeof requestAnimationFrame !== 'function'
      ) {
        setShown(b);
        return;
      }
      const t0 = performance.now();
      const step = (t: number) => {
        const v = tweenAt(a, b, t0, t);
        setShown(v);
        raf = v === b || t - t0 >= TWEEN_MS ? 0 : requestAnimationFrame(step);
        if (!raf) setShown(b);
      };
      raf = requestAnimationFrame(step);
    }),
  );
  onCleanup(stop);
  return shown;
}
