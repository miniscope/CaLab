import { createEffect, Show, type JSX } from 'solid-js';
import { Badge, DashboardPanel, HelpTip, MeterRow } from '@calab/ui';
import {
  FLAT_FIELD_DISPLAY_RANGE,
  FLAT_FIELD_FIRST_S,
  flatFieldBadge,
  flatFieldChangeLine,
  flatFieldSeconds,
  flatFieldStatusLine,
  gainToGray8,
} from '../lib/flat-field.ts';
import { grayToImageData } from '../lib/frame-display.ts';
import type { PipelineStore } from '../lib/pipeline-store.ts';
import { createSampled } from '../lib/sampled.ts';

/** The panel's live figures refresh at most this often, ms (2 Hz). */
const SAMPLE_MS = 500;

/**
 * The sensor flat field: the gain map at a fixed display range (never auto-contrast), a
 * hatched placeholder until there is a map, a badge for its state, the estimate's progress
 * toward the first map, how much the last update changed the data, and the frame where the
 * first map took effect.
 */
export function FlatFieldPanel(props: {
  store: PipelineStore;
  width: number;
  height: number;
}): JSX.Element {
  let canvas!: HTMLCanvasElement;
  const state = createSampled(
    () => props.store.flatField(),
    // A map, an error or a skip shows at once; the frame count waits for the beat.
    () => {
      const s = props.store.flatField();
      return `${s.enabled}|${s.supported}|${s.updates}|${s.map ? 1 : 0}|${s.error}|${s.skipped}`;
    },
    SAMPLE_MS,
  );
  const badge = () => flatFieldBadge(state());
  const [lo, hi] = FLAT_FIELD_DISPLAY_RANGE;
  const hasMap = () => {
    const m = state().map;
    return !!m && m.gain.length === props.width * props.height;
  };

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
    <DashboardPanel id="flatfield" variant="flush" class="cala-flatfield">
      <div class="cala-flatfield__head">
        <h2 class="panel-label">Sensor flat field</h2>
        <Badge tone={badge().tone} testid="flatfield-badge">
          {badge().label}
        </Badge>
        <HelpTip
          label="About the sensor flat field"
          testid="flatfield-help"
          popClass="cala-flatfield__help"
        >
          <p>
            The sensor's per-pixel gain, estimated from how the tissue moves over the sensor, and
            divided out of the raw frames. Black is a gain of {lo}, white {hi}: a fixed range. The
            map is stored in this browser (IndexedDB), per device
            <Show when={state().key?.source === 'folder'}>
              ; with no device serial in the recording&apos;s metadata it is keyed by this folder
              and reused only when the same folder is opened again
            </Show>
            .
          </p>
        </HelpTip>
      </div>
      <div class="cala-flat">
        <div class="cala-flat__image">
          <div class="cala-flatfield__frame" data-state={hasMap() ? 'map' : 'empty'}>
            <canvas
              ref={canvas}
              class="cala-flat__canvas"
              width={props.width}
              height={props.height}
              aria-label="Sensor gain map"
              data-testid="flatfield-canvas"
            />
            <Show when={!hasMap()}>
              <div class="cala-flatfield__placeholder" data-testid="flatfield-placeholder">
                {state().enabled ? 'No map yet' : 'Off'}
              </div>
            </Show>
          </div>
          <div class="cala-flat__legend num" data-testid="flatfield-legend">
            <span>{lo.toFixed(2)}</span>
            <span class="cala-flat__ramp" />
            <span>{hi.toFixed(2)}</span>
          </div>
        </div>
        <div class="cala-flat__text">
          <Show when={badge().estimating}>
            <MeterRow
              label="First map"
              value={flatFieldSeconds(state())}
              min={0}
              max={FLAT_FIELD_FIRST_S}
              format={(v) => Math.floor(v).toLocaleString()}
              display={
                <>
                  {Math.floor(flatFieldSeconds(state()))}
                  <span class="unit"> / {FLAT_FIELD_FIRST_S}</span>
                </>
              }
              unit="s"
              testid="flatfield-progress"
            />
          </Show>
          <p class="cala-flatfield__status" data-testid="flatfield-status">
            {flatFieldStatusLine(state())}
          </p>
          <dl class="cala-info num">
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
          <label class="cala-flat__toggle">
            <input
              type="checkbox"
              checked={props.store.flatEnabled()}
              onChange={(e) => props.store.setFlatEnabled(e.currentTarget.checked)}
              data-testid="flatfield-toggle"
            />
            Divide out the sensor gain map
          </label>
          <p class="cala-muted cala-flatfield__note">Applies the next time Discover starts.</p>
        </div>
      </div>
    </DashboardPanel>
  );
}
