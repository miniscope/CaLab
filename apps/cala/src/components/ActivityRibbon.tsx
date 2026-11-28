import { createEffect, createSignal, onCleanup, onMount, Show, type JSX } from 'solid-js';
import { createThemeVersion } from '@calab/ui';
import {
  RIBBON_BIN_S,
  RIBBON_MAX_SHARE,
  RIBBON_SPAN_S,
  ribbonCaption,
  ribbonHeight,
  SYNC_SHARE,
  soul,
} from '../lib/soul.ts';
import { ONSET_K } from '../lib/activity.ts';

const COLS = Math.round(RIBBON_SPAN_S / RIBBON_BIN_S);
const HEIGHT = 26;

/**
 * The activity ribbon under the field of view: one column per half second of recording over the
 * last minute, its height the share of the library's cells with an onset in that half second, on
 * a fixed scale (0 to `RIBBON_MAX_SHARE`; a taller column is clipped and capped). Columns the
 * sampler never read (a speed above its window) are left empty, not drawn as quiet. A column of
 * many cells at once (`SYNC_SHARE`) is drawn in the warm colour: a burst, or a motion artifact.
 * Redrawn at the sampler's 2 Hz only.
 */
export function ActivityRibbon(props: {
  /** Live activity is the overlay scheme now (the button then reads as on). */
  activityOn: boolean;
  onActivity: () => void;
}): JSX.Element {
  const life = soul();
  let canvas!: HTMLCanvasElement;
  let box!: HTMLDivElement;
  const [width, setWidth] = createSignal(0);
  const [caption, setCaption] = createSignal('Waiting for frames');
  const themeVersion = createThemeVersion();
  onMount(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((es) => setWidth(Math.round(es[0].contentRect.width)));
    ro.observe(box);
    onCleanup(() => ro.disconnect());
  });
  createEffect(() => {
    life.ribbonVersion();
    themeVersion();
    const w = width();
    if (w <= 0) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr);
    if (canvas.height !== Math.round(HEIGHT * dpr)) canvas.height = Math.round(HEIGHT * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const css = getComputedStyle(box);
    const ink = css.getPropertyValue('--cala-ribbon-ink').trim() || '#3b6fa8';
    const hot = css.getPropertyValue('--cala-ribbon-hot').trim() || '#ff9f2e';
    const base = css.getPropertyValue('--cala-ribbon-base').trim() || 'rgba(128,128,128,.35)';
    const { share, count } = life.ribbon().columns(COLS);
    setCaption(ribbonCaption(share, count, 2 / RIBBON_BIN_S));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, HEIGHT);
    const cw = w / COLS;
    const top = 2;
    const hmax = HEIGHT - top - 2;
    for (let i = 0; i < COLS; i++) {
      const s = share[i];
      if (!Number.isFinite(s)) continue;
      const x = i * cw;
      // A read column: a baseline tick, so quiet reads differently from not read.
      ctx.fillStyle = base;
      ctx.fillRect(x, HEIGHT - 2, Math.max(1, cw - 1), 2);
      const { h, clipped } = ribbonHeight(s);
      if (h <= 0) continue;
      ctx.fillStyle = s >= SYNC_SHARE ? hot : ink;
      const bh = Math.max(2, h * hmax);
      ctx.fillRect(x, HEIGHT - 2 - bh, Math.max(1, cw - 1), bh);
      if (clipped) {
        ctx.fillStyle = hot;
        ctx.fillRect(x - 0.5, top - 2, cw, 2);
      }
    }
  });
  return (
    <div class="cala-ribbon" data-testid="activity-ribbon">
      <div class="cala-ribbon__head">
        <span
          class="cala-ribbon__title"
          title={`Population onsets: each column is ${RIBBON_BIN_S} s of recording, its height the share of cells with an onset then (its trace rising ${ONSET_K} noise sigmas over its baseline). Fixed range 0 to ${Math.round(RIBBON_MAX_SHARE * 100)}% of cells; warm columns are ${Math.round(SYNC_SHARE * 100)}% or more at once (a burst, or motion). Last ${RIBBON_SPAN_S} s; empty columns were not read.`}
        >
          Onsets
        </span>
        <span class="cala-ribbon__caption" data-testid="activity-ribbon-caption">
          {caption()}
        </span>
        <Show
          when={!props.activityOn}
          fallback={<span class="cala-ribbon__on">Live activity on</span>}
        >
          <button
            type="button"
            class="cala-ribbon__btn"
            title="Colour the cells by Live activity: each lights up as it fires."
            data-testid="activity-ribbon-show"
            onClick={() => props.onActivity()}
          >
            Show on cells
          </button>
        </Show>
      </div>
      <div ref={box} class="cala-ribbon__plot">
        <canvas
          ref={canvas}
          class="cala-ribbon__canvas"
          style={{ height: `${HEIGHT}px` }}
          role="img"
          aria-label={`Population onsets over the last ${RIBBON_SPAN_S} seconds of recording`}
        />
        <span class="cala-ribbon__axis cala-ribbon__axis--l" aria-hidden="true">
          −{RIBBON_SPAN_S} s
        </span>
        <span class="cala-ribbon__axis cala-ribbon__axis--r" aria-hidden="true">
          now
        </span>
        <span class="cala-ribbon__axis cala-ribbon__axis--top" aria-hidden="true">
          {Math.round(RIBBON_MAX_SHARE * 100)}%
        </span>
      </div>
    </div>
  );
}
