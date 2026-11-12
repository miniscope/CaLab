import { createEffect, Show, type JSX } from 'solid-js';
import { DashboardPanel } from '@calab/ui';
import {
  FLAT_FIELD_DISPLAY_RANGE,
  flatFieldChangeLine,
  flatFieldStatusLine,
  gainToGray8,
} from '../lib/flat-field.ts';
import { grayToImageData } from '../lib/frame-display.ts';
import type { PipelineStore } from '../lib/pipeline-store.ts';

/**
 * The sensor flat field: the gain map (fixed display range, never
 * auto-contrast), where its estimate stands, how much the last update changed
 * the data, and the frame where the first map took effect.
 */
export function FlatFieldPanel(props: {
  store: PipelineStore;
  width: number;
  height: number;
}): JSX.Element {
  let canvas!: HTMLCanvasElement;
  const state = () => props.store.flatField();
  const [lo, hi] = FLAT_FIELD_DISPLAY_RANGE;

  createEffect(() => {
    const map = state().map;
    const w = props.width;
    const h = props.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (!map || map.gain.length !== w * h) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    ctx.putImageData(grayToImageData(gainToGray8(map.gain), w, h), 0, 0);
  });

  return (
    <DashboardPanel id="flatfield" variant="flush">
      <h2 class="panel-label">Sensor flat field</h2>
      <div class="cala-flat">
        <div class="cala-flat__image">
          <canvas
            ref={canvas}
            class="cala-flat__canvas"
            width={props.width}
            height={props.height}
            aria-label="Sensor gain map"
            data-testid="flatfield-canvas"
          />
          <div class="cala-flat__legend" data-testid="flatfield-legend">
            <span>{lo.toFixed(2)}</span>
            <span class="cala-flat__ramp" />
            <span>{hi.toFixed(2)}</span>
          </div>
          <p class="cala-muted">
            Gain {lo} (black) to {hi} (white), a fixed range.
          </p>
        </div>
        <div class="cala-flat__text">
          <label class="cala-flat__toggle">
            <input
              type="checkbox"
              checked={props.store.flatEnabled()}
              onChange={(e) => props.store.setFlatEnabled(e.currentTarget.checked)}
              data-testid="flatfield-toggle"
            />
            Divide out the sensor gain map
          </label>
          <p class="cala-muted">Takes effect the next time pass 1 starts (Restart).</p>
          <dl class="cala-info">
            <dt>Status</dt>
            <dd data-testid="flatfield-status">{flatFieldStatusLine(state())}</dd>
            <Show when={flatFieldChangeLine(state().lastChange)}>
              {(line) => (
                <>
                  <dt>Last update changed the data by</dt>
                  <dd data-testid="flatfield-change">{line()}</dd>
                </>
              )}
            </Show>
            <Show when={state().firstFrame !== null}>
              <dt>First map took effect at</dt>
              <dd data-testid="flatfield-first-frame">
                frame {state().firstFrame!.toLocaleString()}
              </dd>
            </Show>
          </dl>
          <p class="cala-muted">
            The gain map is stored in this browser (IndexedDB), per device.
            <Show when={state().key?.source === 'folder'}>
              {' '}
              No device serial was found in the recording&apos;s metadata, so it is keyed by this
              folder: it is reused only when the same folder is opened again.
            </Show>
          </p>
        </div>
      </div>
    </DashboardPanel>
  );
}
