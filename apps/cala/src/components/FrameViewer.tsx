import { Show, type JSX } from 'solid-js';
import { DashboardPanel, Icon } from '@calab/ui';
import type { ViewerStore } from '../lib/viewer-store.ts';
import { FALLBACK_PLAYBACK_FPS } from '../lib/viewer-store.ts';
import { createHeldRange, RangeControl } from './RangeControl.tsx';
import { FrameCanvas } from './FrameCanvas.tsx';

/**
 * The Raw file tab: the recording's frames as stored, with play/pause, a frame scrubber and
 * the display range (fitted once and held, or the full bit depth). The readout follows the
 * scrubber at once: it is the control's own feedback, not a live figure.
 */
export function FrameViewer(props: { store: ViewerStore }): JSX.Element {
  const store = () => props.store;
  const held = createHeldRange();
  const info = () => store().info()!;
  const seconds = () => store().frameIndex() / (info().fps ?? FALLBACK_PLAYBACK_FPS);

  return (
    <DashboardPanel id="viewer" variant="flush" class="cala-viewer">
      <div class="cala-stage cala-viewer__stage">
        <FrameCanvas
          width={info().width}
          height={info().height}
          bitDepth={info().bitDepth}
          frame={store().frame()}
          autoContrast={store().autoContrast()}
          held={held}
        />
      </div>
      <div class="cala-viewer__transport">
        <button
          type="button"
          class="btn-secondary btn-small cala-viewer__play"
          aria-label={store().playing() ? 'Pause' : 'Play'}
          title={store().playing() ? 'Pause' : 'Play'}
          onClick={() => store().togglePlay()}
        >
          <Icon name={store().playing() ? 'pause' : 'play'} size={14} />
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
        <span class="cala-viewer__readout num" data-testid="frame-readout">
          {(store().frameIndex() + 1).toLocaleString()} / {info().frameCount.toLocaleString()}
          <Show when={info().fps !== null}>
            <span class="unit"> · {seconds().toFixed(2)} s</span>
          </Show>
        </span>
      </div>
      <div class="cala-viewer__display">
        <label class="cala-contrast">
          <input
            type="checkbox"
            checked={store().autoContrast()}
            onChange={(e) => store().setAutoContrast(e.currentTarget.checked)}
          />{' '}
          Fixed range (fitted once, held)
        </label>
        <RangeControl held={held} label="Frame" />
      </div>
    </DashboardPanel>
  );
}
