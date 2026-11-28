/**
 * The Compute block of the Run tab: where the run's machine time goes. Its header names where
 * motion correction runs and how many workers are busy; under it the Speed control (the
 * user-set budget) and, once a run has started, the worker squares.
 */
import { Show, type JSX } from 'solid-js';
import { Icon } from '@calab/ui';
import type { CellStore } from '../lib/cell-store.ts';
import type { PipelineStore } from '../lib/pipeline-store.ts';
import { workByKind } from '../lib/work-meter.ts';
import { busyWorkers, displayState } from '../lib/work-display.ts';
import { SpeedControl } from './SpeedControl.tsx';
import { WorkerSquares } from './WorkDisplay.tsx';

/** Chip text and tooltip for where motion correction runs. */
const MOTION_BACKEND = {
  webgpu: ['GPU motion', 'Motion prefilter and warp run on the GPU (WebGPU).'],
  'wasm-off': ['CPU motion', 'WebGPU turned off with ?gpu=0.'],
  'wasm-unavailable': [
    'CPU motion',
    'WebGPU is not available in this browser (or cannot run these settings).',
  ],
  'wasm-failed': [
    'CPU motion',
    'WebGPU failed during the run; continued on the CPU. See the console.',
  ],
} as const;

export interface ComputeProps {
  pipeline: PipelineStore;
  cells: CellStore;
  live?: boolean;
  /** Frame rate of the recording or stream, Hz (0 when unknown). */
  fps: number;
  /** Show the worker squares (false before the first run of a recording). */
  workers: boolean;
}

export function Compute(props: ComputeProps): JSX.Element {
  const s = () => props.pipeline;
  const backend = () => {
    if (s().fps() <= 0) return null;
    const b = s().motionBackend();
    if (!b) return null;
    return { key: b, text: MOTION_BACKEND[b][0], title: MOTION_BACKEND[b][1] };
  };
  /** Busy workers of the last reading, while a stage runs (after the run it is not a measurement). */
  const busy = () => {
    const r = s().work();
    if (!r) return null;
    const by = workByKind(r);
    return { busy: busyWorkers(by.totals, by.count), count: by.count };
  };
  /** A stage runs (Discover, or the Final settle after it): the reading is a measurement. */
  const running = () => {
    const st = displayState({
      status: s().status(),
      live: props.live === true,
      settling: props.cells.status()?.lookback?.settling === true,
    });
    return st === 'running' || st === 'streaming' || st === 'final-settle' || st === 'paused';
  };
  return (
    <section class="cala-compute" aria-labelledby="run-compute" data-testid="compute">
      <div class="cala-compute__head">
        <h3 id="run-compute" class="cala-run__heading">
          Compute
        </h3>
        <span class="cala-compute__aside">
          <Show when={backend()}>
            {(b) => (
              <span
                class="cala-backend-badge"
                classList={{ 'cala-backend-badge--warning': b().key === 'wasm-failed' }}
                data-testid="motion-backend"
                data-backend={b().key}
                title={b().title}
              >
                <Show when={b().key === 'webgpu'}>
                  <Icon name="gpu" size={12} />
                </Show>
                <Show when={b().key === 'wasm-failed'}>
                  <Icon name="warning" size={12} />
                </Show>
                {b().text}
              </span>
            )}
          </Show>
          <Show when={props.workers && busy()}>
            {(w) => (
              <span
                class="num"
                data-testid="work-busy"
                title="The workers' busy shares over the last second, added up: 2.5 means two and a half workers' worth of time was in use."
              >
                {running() ? w().busy.toFixed(1) : '–'} of {w().count} workers busy
              </span>
            )}
          </Show>
        </span>
      </div>
      <SpeedControl pipeline={s()} cells={props.cells} live={props.live} fps={props.fps} />
      <Show when={props.workers}>
        <WorkerSquares pipeline={s()} cells={props.cells} live={props.live} />
      </Show>
    </section>
  );
}
