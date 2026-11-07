import { Show, type JSX } from 'solid-js';
import { DashboardPanel } from '@calab/ui';
import type { ViewerStore } from '../lib/viewer-store.ts';
import { FALLBACK_PLAYBACK_FPS } from '../lib/viewer-store.ts';
import { FrameCanvas } from './FrameCanvas.tsx';

/** Frame canvas with a scrubber, play/pause and an auto-contrast toggle. */
export function FrameViewer(props: { store: ViewerStore }): JSX.Element {
  const store = () => props.store;
  const info = () => store().info()!;
  const seconds = () => store().frameIndex() / (info().fps ?? FALLBACK_PLAYBACK_FPS);

  return (
    <DashboardPanel id="viewer" variant="flush">
      <div class="cala-stage">
        <FrameCanvas
          width={info().width}
          height={info().height}
          bitDepth={info().bitDepth}
          frame={store().frame()}
          autoContrast={store().autoContrast()}
        />
      </div>
      <div class="cala-controls">
        <button
          type="button"
          class="btn-secondary btn-small cala-play"
          aria-label={store().playing() ? 'Pause' : 'Play'}
          onClick={() => store().togglePlay()}
        >
          {store().playing() ? 'Pause' : 'Play'}
        </button>
        <input
          type="range"
          class="cala-slider"
          aria-label="Frame"
          min="0"
          max={info().frameCount - 1}
          step="1"
          value={store().frameIndex()}
          onInput={(e) => {
            store().pause();
            store().showFrame(Number(e.currentTarget.value));
          }}
        />
        <span class="cala-readout" data-testid="frame-readout">
          {store().frameIndex() + 1} / {info().frameCount.toLocaleString()}
          <Show when={info().fps !== null}> &middot; {seconds().toFixed(2)} s</Show>
        </span>
        <label class="cala-contrast">
          <input
            type="checkbox"
            checked={store().autoContrast()}
            onChange={(e) => store().setAutoContrast(e.currentTarget.checked)}
          />{' '}
          Auto contrast
        </label>
      </div>
    </DashboardPanel>
  );
}
