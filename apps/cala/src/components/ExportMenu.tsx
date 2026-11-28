/**
 * The run's export, the run rail's one primary button once there is a result: the .npz (with
 * the run record) and the CaDecon file, streamed to disk with progress and errors beside it.
 */
import { createSignal, Show, type JSX } from 'solid-js';
import type { ByteSink } from '@calab/io';
import type { CellStore } from '../lib/cell-store.ts';
import type { PipelineStore } from '../lib/pipeline-store.ts';
import type { Pass2Result, Pass2Store } from '../lib/pass2-store.ts';
import type { RunRecordExtras } from '../lib/run-provenance.ts';
import { extractAfterDiscover, type StageLog } from '../lib/run-stages.ts';
import { markResultExported } from '../lib/export-state.ts';
import { reportResultsExported } from '../lib/analytics-integration.ts';
import { fileFactorNotes } from '../lib/factor-run.ts';
import { errMsg } from '../lib/errors.ts';
import {
  cadeconCells,
  cadeconIsClassic,
  calaExportBytes,
  FACTORS_EXPORT_NOTE,
  exportFormatVersion,
  factorTailNote,
  fileStem,
  saveExport,
  writeCaDeconExport,
  writeCalaExport,
  type ExportInput,
} from '../lib/export.ts';
import type { HistoryUi } from './HistoryPanel.tsx';

export interface ExportMenuProps {
  pipeline: PipelineStore;
  pass2: Pass2Store;
  cells: CellStore;
  stages: StageLog;
  /** The run's history views (their bins and events go into the export). */
  ui: HistoryUi;
  /** A live source: the export takes the live traces (`liveResult`). */
  live?: boolean;
  /** A live run's traces once it has ended (null otherwise; always null for a recording). */
  liveResult: () => Pass2Result | null;
  /** Why a live run's traces could not be gathered (null: no error). */
  liveError?: () => string | null;
  label: string;
  width: number;
  height: number;
  /** Frame rate, Hz (0 when unknown). */
  fps: number;
  /** Bits per pixel of the recording (the exported images' display ranges). */
  bitDepth?: number;
  /** The run record with this menu's settings added; written into each export. */
  runRecord?: (extras: RunRecordExtras) => Record<string, unknown>;
}

/** The export (see the module comment); renders nothing before there is a result. */
export function ExportMenu(props: ExportMenuProps): JSX.Element {
  const s = () => props.pipeline;
  const [passOnly, setPassOnly] = createSignal(true);
  const [exporting, setExporting] = createSignal<string | null>(null);
  const [exportError, setExportError] = createSignal<string | null>(null);
  const exportResult = () => props.pass2.result() ?? props.liveResult();
  const failure = () => exportError() ?? props.liveError?.() ?? null;

  /** Stream one export to disk (see `saveExport`), with progress and errors beside the button. */
  async function runExport(
    name: string,
    sizeHint: number,
    write: (sink: ByteSink, progress: (done: number, total: number) => void) => Promise<void>,
    formatVersion?: number,
  ): Promise<void> {
    setExportError(null);
    setExporting(`Exporting ${name}`);
    try {
      await saveExport(name, sizeHint, (sink) =>
        write(sink, (done, all) =>
          setExporting(`Exporting ${name}: ${all > 0 ? Math.floor((100 * done) / all) : 0}%`),
        ),
      );
      reportResultsExported(1, formatVersion);
      markResultExported();
    } catch (err) {
      setExportError(errMsg(err));
    } finally {
      setExporting(null);
    }
  }

  /**
   * A `?factors` stream: Extract's traces are the export's, with the live traces beside them
   * (when they are for the same cells), the notes, and the frames both cover.
   */
  const factorExport = (
    r: Pass2Result,
  ): Pick<ExportInput, 'liveTraces' | 'notes' | 'frameRange'> | null => {
    if (!props.live) {
      // A recording's factor run (GPU or `?factors=file`): notes on what the settle and Extract read.
      const notes = fileFactorNotes(props.stages.runs());
      return notes.length ? { notes } : null;
    }
    if (r.source !== 'factors') return null;
    const live = props.liveResult();
    const same =
      live !== null &&
      live.ids.length === r.ids.length &&
      live.ids.every((id, i) => id === r.ids[i]);
    if (live && !same)
      console.warn('cala export: the live traces are for other cells than Extract; left out.');
    const tail = live !== null && r.frames < live.frames;
    return {
      ...(live && same ? { liveTraces: live.traces } : {}),
      notes: [FACTORS_EXPORT_NOTE, ...(tail ? [factorTailNote(r.frames, live.frames)] : [])],
      ...(tail ? { frameRange: { start: 0, end: r.frames } } : {}),
    };
  };
  /** `withRecord`: gather the run record (at write time only; the cell count in the button reads this reactively without it). */
  const exportInput = (withRecord = false): ExportInput | null => {
    const r = exportResult();
    if (!r) return null;
    return {
      ...factorExport(r),
      label: props.label,
      width: props.width,
      height: props.height,
      fps: props.fps,
      result: r,
      run: s().record().snapshot(),
      flatField: s().record().flatFieldApplied,
      flatFieldMap: s().flatFieldMap(),
      ...(props.bitDepth ? { bitDepth: props.bitDepth } : {}),
      stages: props.stages.runs(),
      qc: props.cells.qc(),
      firstSeen: props.cells.firstSeen,
      history: {
        bins: props.ui.run.history().toExport(),
        eventsJson: props.ui.run.events().toJSON(),
      },
      ...(withRecord && props.runRecord
        ? {
            runRecord: props.runRecord({
              extractAfterDiscover: extractAfterDiscover(),
              passQcOnly: passOnly(),
            }),
          }
        : {}),
      version: import.meta.env.VITE_APP_VERSION || 'dev',
    };
  };
  const keptForCaDecon = () => {
    const input = exportInput();
    return input ? cadeconCells(input, passOnly()).length : 0;
  };

  return (
    <Show when={exportResult() || exporting() || failure()}>
      <div class="cala-export" data-testid="run-export">
        <details class="cala-menu" data-testid="export-menu">
          <summary class="btn-primary btn-small" aria-disabled={!exportResult()}>
            Export &#9662;
          </summary>
          <div class="cala-menu__body">
            <button
              type="button"
              class="btn-secondary btn-small"
              data-testid="export-npz"
              disabled={!exportResult() || exporting() !== null}
              title={
                props.live
                  ? 'Footprints, the live traces, motion, flicker, cell metadata and the run record (NumPy .npz).'
                  : "Footprints, Extract's traces, motion, flicker, the stages run, cell metadata and the run record (NumPy .npz)."
              }
              onClick={() => {
                const input = exportInput(true);
                if (input)
                  void runExport(
                    `${fileStem(props.label)}_cala.npz`,
                    calaExportBytes(input),
                    (sink, prog) => writeCalaExport(input, sink, { onProgress: prog }),
                    exportFormatVersion(input),
                  );
              }}
            >
              Export (.npz)
            </button>
            <button
              type="button"
              class="btn-secondary btn-small"
              data-testid="export-cadecon"
              disabled={!exportResult() || exporting() !== null}
              title={`Traces for CaDecon (open the file there, sampling rate ${props.fps > 0 ? `${props.fps} Hz` : 'of your recording'}).`}
              onClick={() => {
                const input = exportInput(true);
                if (input)
                  void runExport(
                    `${fileStem(props.label)}_cala_cadecon.npz`,
                    input.result.frames * cadeconCells(input, passOnly()).length * 4,
                    (sink, prog) =>
                      writeCaDeconExport(input, sink, passOnly(), { onProgress: prog }),
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
              QC-passing cells only (CaDecon)
            </label>
            <Show
              when={
                exportResult() &&
                !cadeconIsClassic(
                  exportResult()!.frames,
                  cadeconCells(exportInput()!, passOnly()).length,
                )
              }
            >
              <span class="cala-readout cala-wrap" data-testid="cadecon-large-note">
                Too large for CaDecon to open (over 512 MB of traces): use the .npz with np.load, or
                export fewer cells.
              </span>
            </Show>
          </div>
        </details>
        <span class="cala-export__note">
          <Show
            when={exporting()}
            fallback={
              <Show
                when={failure()}
                fallback={<span data-testid="export-record-note">Includes the run record</span>}
              >
                <span class="cala-status" data-testid="export-error" data-state="error">
                  Export failed: {failure()}
                </span>
              </Show>
            }
          >
            <span class="cala-num" data-testid="export-progress">
              {exporting()}
            </span>
          </Show>
        </span>
      </div>
    </Show>
  );
}
