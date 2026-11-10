import { createSignal, createEffect, on, Show, type JSX } from 'solid-js';
import { DashboardPanel } from '@calab/ui';
import type { CellStore } from '../lib/cell-store.ts';
import type { CompressStore } from '../lib/compress-store.ts';
import type { PipelineStore } from '../lib/pipeline-store.ts';
import type { Pass2Result, Pass2Store } from '../lib/pass2-store.ts';
import {
  buildCaDeconExport,
  buildCalaExport,
  cadeconCells,
  downloadBytes,
  fileStem,
  type ExportInput,
} from '../lib/export.ts';

export interface Pass2BarProps {
  pipeline: PipelineStore;
  pass2: Pass2Store;
  cells: CellStore;
  /** The compression (`?compress`): its back-fill stands in for pass 2 when there is no file. */
  compress?: CompressStore;
  /** A live source: no file to re-read, so pass 2 cannot run; the stop button ends the stream. */
  live?: boolean;
  /** Recording label (the folder name). */
  label: string;
  width: number;
  height: number;
  /** Frame rate, Hz (0 when unknown). */
  fps: number;
}

/**
 * Pass 2 and export: ends pass 1 early on request, re-extracts every frame's
 * traces with the final library, then offers the two downloads (all of it as
 * `.npz`, and the traces for CaDecon). On a live source the export takes the
 * back-filled traces instead (solved from the compressed windows).
 */
export function Pass2Bar(props: Pass2BarProps): JSX.Element {
  const p = () => props.pass2;
  const [auto, setAuto] = createSignal(true);
  const [passOnly, setPassOnly] = createSignal(true);

  /** The back-fill's traces as a pass-2 result, when its library is the current one. */
  const backfillResult = (): Pass2Result | null => {
    const r = props.compress?.result();
    const library = props.cells.library();
    if (!r || !library || library.version !== r.version) return null;
    return { ...r, library };
  };
  const exportResult = () => p().result() ?? backfillResult();

  // A new pass 1 invalidates pass 2's result.
  createEffect(
    on(
      () => props.pipeline.status(),
      (st) => {
        if (st === 'starting') p().clear();
      },
    ),
  );
  // Pass 2 follows pass 1 once the final library is out.
  createEffect(() => {
    if (
      auto() &&
      !props.live &&
      props.pipeline.status() === 'done' &&
      p().status() === 'idle' &&
      p().blockedReason() === null
    )
      void p().run();
  });

  const pass1Busy = () =>
    props.pipeline.status() === 'running' || props.pipeline.status() === 'paused';
  const statusText = () => {
    switch (p().status()) {
      case 'running':
        return 'Pass 2: re-extracting traces with the final library';
      case 'done': {
        const r = p().result();
        return r
          ? `Pass 2 done: ${r.cells} cells x ${r.frames.toLocaleString()} frames in ${r.seconds.toFixed(1)} s (${(r.frames / r.seconds).toFixed(0)} frames/s)`
          : 'Pass 2 done';
      }
      case 'error':
        return `Pass 2 stopped: ${p().error() ?? 'error'}`;
      case 'cancelled':
        return 'Pass 2 cancelled';
      default:
        if (props.live) {
          const b = props.compress?.backfill();
          if (pass1Busy()) return 'Live: the traces are back-filled from the compressed windows';
          return b
            ? `Back-filled ${b.frames.toLocaleString()} frames from ${b.windows} windows with library v${b.version}`
            : props.compress
              ? 'Live run ended: waiting for the back-fill'
              : 'Live run ended (no compression: add ?compress for a back-fill)';
        }
        return pass1Busy()
          ? 'Pass 2 starts when pass 1 finishes'
          : (p().blockedReason() ?? 'Ready for pass 2');
    }
  };

  const exportInput = (): ExportInput | null => {
    const r = exportResult();
    if (!r) return null;
    return {
      label: props.label,
      width: props.width,
      height: props.height,
      fps: props.fps,
      result: r,
      run: props.pipeline.record().snapshot(),
      qc: props.cells.qc(),
      firstSeen: props.cells.firstSeen,
      version: import.meta.env.VITE_APP_VERSION || 'dev',
    };
  };
  const keptForCaDecon = () => {
    const input = exportInput();
    return input ? cadeconCells(input, passOnly()).length : 0;
  };

  return (
    <DashboardPanel id="pass2" variant="controls" class="cala-statusbar">
      <span class="cala-status" data-testid="pass2-status" data-state={p().status()}>
        {statusText()}
      </span>
      <Show when={p().status() === 'running' || p().status() === 'done'}>
        <div
          class="cala-progress"
          role="progressbar"
          aria-valuemin="0"
          aria-valuemax={p().total()}
          aria-valuenow={p().processed()}
        >
          <div
            class="cala-progress__bar"
            style={{
              width: `${(p().total() > 0 ? (100 * p().processed()) / p().total() : 0).toFixed(2)}%`,
            }}
          />
        </div>
        <span class="cala-readout" data-testid="pass2-readout">
          frame {p().processed().toLocaleString()} / {p().total().toLocaleString()}
          <Show when={p().status() === 'running' && p().fps() > 0}>
            {' '}
            &middot; {p().fps().toFixed(1)} frames/s
          </Show>
          <Show when={p().motionBackend() === 'webgpu'}> &middot; warp: WebGPU</Show>
        </span>
      </Show>
      <div class="cala-statusbar__actions">
        <Show when={pass1Busy()}>
          <button
            type="button"
            class="btn-secondary btn-small"
            data-testid="pass2-finish"
            title={
              props.live
                ? 'End the live run here: the cells found so far become the final library and the traces are back-filled.'
                : 'Stop reading here: the cells found so far become the final library, then pass 2 runs over the frames read.'
            }
            onClick={() => void props.pipeline.finishEarly()}
          >
            {props.live ? 'Stop the live run' : 'Finish pass 1 now'}
          </button>
        </Show>
        <Show
          when={p().status() !== 'running' && !props.live}
          fallback={
            <button type="button" class="btn-secondary btn-small" onClick={() => p().cancel()}>
              Cancel pass 2
            </button>
          }
        >
          <button
            type="button"
            class="btn-secondary btn-small"
            data-testid="pass2-run"
            disabled={p().blockedReason() !== null}
            title={p().blockedReason() ?? 'Re-extract every frame with the final library.'}
            onClick={() => void p().run()}
          >
            Run pass 2
          </button>
        </Show>
        <Show when={!props.live}>
          <label class="cala-check">
            <input
              type="checkbox"
              checked={auto()}
              onChange={(e) => setAuto(e.currentTarget.checked)}
            />
            Run automatically after pass 1
          </label>
        </Show>
      </div>
      <div class="cala-statusbar__actions">
        <button
          type="button"
          class="btn-secondary btn-small"
          data-testid="export-npz"
          disabled={!exportResult()}
          title="Footprints, pass-2 traces, motion, flicker and cell metadata (NumPy .npz)."
          onClick={() => {
            const input = exportInput();
            if (input) downloadBytes(`${fileStem(props.label)}_cala.npz`, buildCalaExport(input));
          }}
        >
          Export (.npz)
        </button>
        <button
          type="button"
          class="btn-secondary btn-small"
          data-testid="export-cadecon"
          disabled={!exportResult()}
          title={`Traces for CaDecon (open the file there, sampling rate ${props.fps > 0 ? `${props.fps} Hz` : 'of your recording'}).`}
          onClick={() => {
            const input = exportInput();
            if (input)
              downloadBytes(
                `${fileStem(props.label)}_cala_cadecon.npz`,
                buildCaDeconExport(input, passOnly()),
              );
          }}
        >
          Export for CaDecon{exportResult() ? ` (${keptForCaDecon()} cells)` : ''}
        </button>
        <label class="cala-check">
          <input
            type="checkbox"
            checked={passOnly()}
            onChange={(e) => setPassOnly(e.currentTarget.checked)}
          />
          QC-passing cells only
        </label>
      </div>
    </DashboardPanel>
  );
}
