import { Show, type JSX } from 'solid-js';
import { DashboardPanel } from '@calab/ui';
import type { CellStore } from '../lib/cell-store.ts';
import type { PipelineStore } from '../lib/pipeline-store.ts';

const SETUP_LABEL = {
  calibrate: 'Calibrating (FOV mask, hot pixels)',
  'motion-warmup': 'Building the motion template',
} as const;

/** One compact strip: pipeline status and progress, run controls, the cell count. */
export function StatusBar(props: { store: PipelineStore; cells: CellStore }): JSX.Element {
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
