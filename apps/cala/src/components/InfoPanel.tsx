import { For, Show, type JSX } from 'solid-js';
import { DashboardPanel } from '@calab/ui';
import type { FrameSourceInfo } from '../lib/frame-source.ts';

const FPS_SOURCE_LABEL = {
  timestamps: 'timeStamps.csv (mean frame interval)',
  metadata: 'metaData.json',
  none: 'not found',
} as const;

function fpsText(info: FrameSourceInfo): string {
  return info.fps === null
    ? 'unknown'
    : `${info.fps.toFixed(2)} Hz from ${FPS_SOURCE_LABEL[info.fpsSource]}`;
}

/** Recording facts: dimensions, frame count, files, where the frame rate came from. */
export function InfoPanel(props: { info: FrameSourceInfo }): JSX.Element {
  const i = () => props.info;
  return (
    <DashboardPanel id="info" variant="flush">
      <h2 class="panel-label">Recording</h2>
      <dl class="cala-info">
        <dt>Frame size</dt>
        <dd>
          {i().width} x {i().height} px, {i().bitDepth}-bit ({i().fourcc})
        </dd>
        <dt>Frames</dt>
        <dd>{i().frameCount.toLocaleString()}</dd>
        <dt>Frame rate</dt>
        <dd>{fpsText(i())}</dd>
        <Show when={i().aviDeclaredFps !== null}>
          <dt>AVI header rate</dt>
          <dd>{i().aviDeclaredFps!.toFixed(1)} Hz (declared by the writer, ignored)</dd>
        </Show>
        <dt>Row order</dt>
        <dd>{i().bottomUp ? 'bottom-up DIB, shown as stored' : 'top-down'}</dd>
        <dt>Files</dt>
        <dd>
          {i().files.length} video file{i().files.length === 1 ? '' : 's'}
          <ul class="cala-files">
            <For each={i().files}>
              {(f) => (
                <li>
                  {f.name} <span class="cala-muted">({f.frames.toLocaleString()} frames)</span>
                </li>
              )}
            </For>
          </ul>
        </dd>
      </dl>
      <Show when={i().ignoredFiles.length > 0}>
        <p class="cala-muted">
          {i().ignoredFiles.length} other file{i().ignoredFiles.length === 1 ? '' : 's'} in the
          selection not used.
        </p>
      </Show>
      <For each={i().warnings}>{(w) => <p class="cala-warning">{w}</p>}</For>
    </DashboardPanel>
  );
}
