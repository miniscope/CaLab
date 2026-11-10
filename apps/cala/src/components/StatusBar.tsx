import { Show, type JSX } from 'solid-js';
import { DashboardPanel } from '@calab/ui';
import type { CellStore } from '../lib/cell-store.ts';
import { compressReadout, type CompressStore } from '../lib/compress-store.ts';
import type { PipelineStore } from '../lib/pipeline-store.ts';

const SETUP_LABEL = {
  calibrate: 'Calibrating (FOV mask, hot pixels)',
  'motion-warmup': 'Building the motion template',
} as const;

/** Badge text and tooltip for where motion correction runs. */
const MOTION_BACKEND = {
  webgpu: ['Motion: WebGPU', 'Motion prefilter and warp run on the GPU.'],
  'wasm-off': ['Motion: CPU', 'WebGPU turned off with ?gpu=0.'],
  'wasm-unavailable': [
    'Motion: CPU',
    'WebGPU is not available in this browser (or cannot run these settings).',
  ],
  'wasm-failed': [
    'Motion: CPU',
    'WebGPU failed during the run; continued on the CPU. See the console.',
  ],
  single: ['Motion: CPU', 'Single-worker pipeline (?pipeline=0) runs motion in WASM.'],
} as const;

/** One compact strip: pipeline status and progress, run controls, the cell count. */
export function StatusBar(props: {
  store: PipelineStore;
  cells: CellStore;
  /** Present when the run compresses its frames (`?compress`). */
  compress?: CompressStore;
}): JSX.Element {
  const s = () => props.store;
  const c = () => props.cells;

  const total = () => s().plan()?.frameCount ?? 0;
  const fraction = () => (total() > 0 ? s().processed() / total() : 0);
  const statusText = () => {
    const st = s().status();
    if (st === 'starting') return 'Starting';
    if (st === 'error') return 'Stopped by an error';
    if (st === 'done') return 'Done';
    const setup = s().setup();
    const prefix = st === 'paused' ? 'Paused: ' : '';
    if (s().processed() === 0 && setup) {
      return `${prefix}${SETUP_LABEL[setup.phase]} ${setup.done} / ${setup.total}`;
    }
    return st === 'paused' ? 'Paused' : 'Running';
  };
  const backend = () => {
    if (s().fps() <= 0) return null;
    const b = s().motionBackend() ?? 'single';
    return { key: b, text: MOTION_BACKEND[b][0], title: MOTION_BACKEND[b][1] };
  };
  const busy = () => s().status() === 'running' || s().status() === 'paused';
  const lagNow = () => {
    c().tick();
    const v = c().metrics().lag.at(-1);
    return v === null || v === undefined ? null : v;
  };

  return (
    <DashboardPanel id="pipeline" variant="controls" class="cala-statusbar">
      <span class="cala-status" data-testid="pipeline-status">
        {statusText()}
      </span>
      <div
        class="cala-progress"
        role="progressbar"
        aria-valuemin="0"
        aria-valuemax={total()}
        aria-valuenow={s().processed()}
      >
        <div class="cala-progress__bar" style={{ width: `${(fraction() * 100).toFixed(2)}%` }} />
      </div>
      <span class="cala-readout" data-testid="pipeline-readout">
        frame {s().processed().toLocaleString()} / {total().toLocaleString()}
        <Show when={s().fps() > 0}> &middot; {s().fps().toFixed(1)} frames/s</Show>
      </span>
      <Show when={backend()}>
        {(b) => (
          <span
            class="cala-backend-badge"
            classList={{ 'cala-backend-badge--gpu': b().key === 'webgpu' }}
            data-testid="motion-backend"
            data-backend={b().key}
            title={b().title}
          >
            {b().text}
          </span>
        )}
      </Show>
      <div class="cala-statusbar__actions">
        <button
          type="button"
          class="btn-secondary btn-small cala-pipeline-toggle"
          disabled={!busy()}
          onClick={() => s().togglePause()}
        >
          {s().status() === 'paused' ? 'Resume' : 'Pause'}
        </button>
        <button type="button" class="btn-secondary btn-small" onClick={() => void s().start()}>
          Restart
        </button>
        <label class="cala-check">
          <input
            type="checkbox"
            checked={s().discover()}
            onChange={(e) => s().setDiscover(e.currentTarget.checked)}
          />
          Discover cells
        </label>
      </div>
      <span class="cala-readout cala-statusbar__cells" data-testid="cells-readout">
        {c().library()?.ids.length ?? 0} cells &middot; library v{c().version()} &middot; lag{' '}
        {lagNow() ?? 'n/a'} frames
      </span>
      <Show when={props.compress}>
        {(compress) => (
          <span class="cala-readout" data-testid="compress-readout">
            {compress().error() ?? compressReadout(compress().status(), compress().backfill())}
          </span>
        )}
      </Show>
      <Show when={c().status()?.reservoirWarning}>
        {(w) => (
          <p
            class="cala-warning cala-statusbar__warning"
            role="status"
            data-testid="statusbar-warning"
          >
            {w()}
          </p>
        )}
      </Show>
      <Show when={s().error()}>
        {(message) => (
          <div class="error-card cala-statusbar__error" role="alert">
            <span>{message()}</span>
          </div>
        )}
      </Show>
      <Show when={c().error()}>
        {(message) => (
          <div class="error-card cala-statusbar__error" role="alert">
            <span>Cell discovery stopped: {message()}</span>
          </div>
        )}
      </Show>
    </DashboardPanel>
  );
}
