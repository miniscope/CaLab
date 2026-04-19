import { type JSX } from 'solid-js';
import { dashboard } from '../../lib/dashboard-store.ts';
import { FrameStagePanel } from './FrameStagePanel.tsx';

/**
 * 4-canvas frame panel (design §8 "Frame panel", Phase 7 task 7).
 * Shows the preprocess pipeline's raw → hot-pixel → motion stages
 * side-by-side with the fit pipeline's reconstruction `Ãc`, so the
 * user can see what fit is seeing and how close the model's guess is
 * to the observed frame.
 *
 * Scrubber is deferred (design §8 notes it as Phase 8 polish — needs
 * main-thread frame history per stage, which is a separate data
 * plumbing task).
 */
export function FrameQuad(): JSX.Element {
  const caption = (): string => {
    const idx = dashboard.currentFrameIndex;
    const ep = dashboard.currentEpoch;
    if (idx === null || ep === null) return 'awaiting frames…';
    return `frame ${idx} · epoch ${ep.toString()}`;
  };

  return (
    <div class="frame-quad">
      <div class="frame-quad__grid">
        <FrameStagePanel stage="raw" label="raw" />
        <FrameStagePanel stage="hotPixel" label="hot-pixel" />
        <FrameStagePanel stage="motion" label="motion-corrected" />
        <FrameStagePanel stage="reconstruction" label="reconstruction (Ãc)" />
      </div>
      <div class="frame-quad__caption">{caption()}</div>
    </div>
  );
}
