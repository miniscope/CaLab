import { createSignal, For, Show, type JSX } from 'solid-js';
import { DashboardPanel } from '@calab/ui';
import type { BatchPreviews } from '../lib/pipeline-engine.ts';
import type { PipelineStore } from '../lib/pipeline-store.ts';
import { MotionTrace } from './MotionTrace.tsx';
import { PreviewCanvas } from './PreviewCanvas.tsx';

type View = keyof Omit<BatchPreviews, 'frame'>;

const VIEW_LABEL: Record<View, string> = {
  raw: 'Raw',
  preprocessed: 'Preprocessed (hot pixels, glow, lines)',
  corrected: 'Motion-corrected',
  output: 'Motion-corrected, background removed',
};

const LEFT_VIEWS: View[] = ['raw', 'preprocessed'];
const RIGHT_VIEWS: View[] = ['corrected', 'output'];

const SETUP_LABEL = {
  calibrate: 'Calibrating (FOV mask, hot pixels)',
  'motion-warmup': 'Building the motion template',
} as const;

function ViewSelect(props: { views: View[]; value: View; onChange: (v: View) => void }) {
  return (
    <select
      class="cala-view-select"
      aria-label="View"
      value={props.value}
      onChange={(e) => props.onChange(e.currentTarget.value as View)}
    >
      <For each={props.views}>{(v) => <option value={v}>{VIEW_LABEL[v]}</option>}</For>
    </select>
  );
}

/** Live raw-vs-corrected video, motion trace, progress and throughput. */
export function PipelinePanel(props: { store: PipelineStore }): JSX.Element {
  const s = () => props.store;
  const [left, setLeft] = createSignal<View>('raw');
  const [right, setRight] = createSignal<View>('corrected');

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
    return `${prefix}Preprocessing and motion correction`;
  };
  const busy = () => s().status() === 'running' || s().status() === 'paused';

  return (
    <DashboardPanel id="pipeline" variant="data">
      <div class="cala-pipeline-head">
        <h2 class="panel-label">Preprocessing and motion correction</h2>
        <span class="cala-readout" data-testid="pipeline-status">
          {statusText()}
        </span>
      </div>
      <div
        class="cala-progress"
        role="progressbar"
        aria-valuemin="0"
        aria-valuemax={total()}
        aria-valuenow={s().processed()}
      >
        <div class="cala-progress__bar" style={{ width: `${(fraction() * 100).toFixed(2)}%` }} />
      </div>

      <div class="cala-pair">
        <figure class="cala-pane">
          <ViewSelect views={LEFT_VIEWS} value={left()} onChange={setLeft} />
          <div class="cala-stage">
            <PreviewCanvas image={s().previews()?.[left()] ?? null} label={VIEW_LABEL[left()]} />
          </div>
        </figure>
        <figure class="cala-pane">
          <ViewSelect views={RIGHT_VIEWS} value={right()} onChange={setRight} />
          <div class="cala-stage">
            <PreviewCanvas image={s().previews()?.[right()] ?? null} label={VIEW_LABEL[right()]} />
          </div>
        </figure>
      </div>

      <div class="cala-controls">
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
        <span class="cala-readout" data-testid="pipeline-readout">
          frame {s().processed().toLocaleString()} / {total().toLocaleString()}
          <Show when={s().fps() > 0}> &middot; {s().fps().toFixed(1)} frames/s</Show>
        </span>
        <Show when={s().processed() > 0}>
          <span class="cala-muted" data-testid="pipeline-stages">
            ms/frame: read {s().stageMs().readMs.toFixed(1)}, preprocess{' '}
            {s().stageMs().preprocessMs.toFixed(1)}, motion {s().stageMs().motionMs.toFixed(1)}
          </span>
        </Show>
      </div>

      <Show when={s().error()}>
        {(message) => (
          <div class="error-card" role="alert">
            <span>{message()}</span>
          </div>
        )}
      </Show>

      <MotionTrace store={s()} />
    </DashboardPanel>
  );
}
