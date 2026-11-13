/**
 * A saved result in the viewer, read-only (docs/projects.md, "View results"):
 * the export of one session (`result-file.ts`) in the same panels as the app
 * right after a run: the field of view with the cells over the mean or max
 * image, the selected cell with its Extract trace, the QC table, the History
 * plots and event log, the flat field and the stages that ran. Nothing runs:
 * there are no Discover, Refine or Extract controls; a new run starts from the
 * project. Parts an older export lacks say "not in this export".
 */
import { createEffect, createSignal, For, on, onCleanup, Show, type JSX } from 'solid-js';
import { ProgressBar } from '@calab/ui';
import { createCellStore } from '../lib/cell-store.ts';
import { createFovLayout } from '../lib/fov-layout.ts';
import { gainToGray8 } from '../lib/flat-field.ts';
import { grayToImageData } from '../lib/frame-display.ts';
import type { LoadedResult, ResultPart } from '../lib/result-file.ts';
import { createRunHistory } from '../lib/run-history.ts';
import { STAGE_LABEL, type StageRun } from '../lib/run-stages.ts';
import { DetailsTabs } from './DetailsTabs.tsx';
import { FovPanel, type FovSource } from './FovPanel.tsx';
import { createHistoryUi, GroupPlot, HistoryExpanded, RunStrip } from './HistoryPanel.tsx';
import { SelectedCellPanel } from './CellsPanel.tsx';
import { SidePanel } from './SidePanel.tsx';

/** Where the result came from (the project index), for the readout. */
export interface ResultOrigin {
  session?: string;
  run?: string;
  path?: string;
  created?: string | null;
}

/** Trace frames read per step while loading (about 16 MB of float32). */
const LOAD_BYTES = 16 * 1048576;

export const PART_LABEL: Record<ResultPart, string> = {
  fov: 'field-of-view images (export format 4)',
  flatfield: 'flat-field map',
  history: 'History plots and event log',
  stages: 'stage list (format 3)',
  qc: 'QC columns',
};

const NOT_IN_EXPORT = 'Not in this export';

/** The FOV source of a result: its mean and max images, each with its stored fixed range. */
export function resultFovSource(r: LoadedResult): FovSource {
  const TITLE: Record<string, [string, string]> = {
    fov_mean: [
      'Mean',
      'Mean of the registered, preprocessed frames before background removal (Extract, every frame).',
    ],
    fov_max: [
      'Max',
      'Max of the registered frames with the background floor removed (Extract, every frame): every cell that fired.',
    ],
  };
  const views = r.images.map((im) => ({
    value: im.key,
    label: TITLE[im.key]?.[0] ?? im.key,
    title: im.domain || TITLE[im.key]?.[1] || im.key,
  }));
  return {
    views:
      views.length > 0
        ? views
        : [{ value: 'none', label: 'No image', title: 'This export holds no FOV image.' }],
    initial: views.at(-1)?.value ?? 'none',
    image: (v) => r.images.find((im) => im.key === v) ?? null,
    frame: () => null,
    fixedRange: (v) => r.images.find((im) => im.key === v)?.range ?? null,
    emptyText: () =>
      r.images.length === 0
        ? `${NOT_IN_EXPORT}: the field-of-view images came with export format 4 (this file is format ${r.formatVersion}). The cells are drawn without an image.`
        : null,
  };
}

/** A stage run as one line: `Refine 2: done, 2,000 frames, 41 cells`. */
export function stageLine(r: StageRun): string {
  const name = r.stage === 'discover' ? STAGE_LABEL.discover : `${STAGE_LABEL[r.stage]} ${r.index}`;
  const parts = [`${r.frames.toLocaleString()} frames`, `${r.cells} cells`];
  if (r.stage === 'refine' && r.footprintsRefined !== undefined)
    parts.push(`${r.footprintsRefined} footprints refined`);
  if (r.stage === 'discover' && r.adds !== undefined) parts.push(`${r.adds} adds`);
  return `${name}: ${r.outcome}, ${parts.join(', ')}`;
}

function fmtDuration(frames: number, fps: number): string {
  if (!(fps > 0)) return `${frames.toLocaleString()} frames`;
  const s = frames / fps;
  return `${frames.toLocaleString()} frames (${s >= 60 ? `${(s / 60).toFixed(1)} min` : `${s.toFixed(1)} s`})`;
}

/** The flat-field tab of a result: the stored gain map on its fixed range. */
function ResultFlatField(props: { result: LoadedResult }): JSX.Element {
  let canvas!: HTMLCanvasElement;
  const ff = () => props.result.flatField;
  createEffect(() => {
    const f = ff();
    const ctx = canvas?.getContext('2d');
    if (!f || !ctx) return;
    ctx.putImageData(grayToImageData(gainToGray8(f.data), f.width, f.height), 0, 0);
  });
  const maps = () =>
    ((props.result.meta.flat_field as { discover_maps?: unknown[] } | undefined)?.discover_maps ??
      []) as { frame: number; source: string }[];
  return (
    <div class="cala-flat" data-testid="result-flatfield">
      <Show
        when={ff()}
        fallback={
          <p class="cala-muted">
            {NOT_IN_EXPORT}:{' '}
            {props.result.formatVersion >= 4
              ? 'this run applied no flat field.'
              : `the flat-field map came with export format 4${
                  maps().length > 0
                    ? `; this run applied ${maps().length} map${maps().length > 1 ? 's' : ''} (the metadata lists them).`
                    : '.'
                }`}
          </p>
        }
      >
        {(f) => (
          <>
            <div class="cala-flat__image">
              <canvas
                ref={canvas}
                class="cala-flat__canvas"
                width={f().width}
                height={f().height}
                aria-label="Sensor gain map"
                data-testid="flatfield-canvas"
              />
              <div class="cala-flat__legend">
                <span>{f().range.lo.toFixed(2)}</span>
                <span class="cala-flat__ramp" />
                <span>{f().range.hi.toFixed(2)}</span>
              </div>
              <p class="cala-muted">
                Gain {f().range.lo} (black) to {f().range.hi} (white), a fixed range.
              </p>
            </div>
            <dl class="cala-info cala-flat__text">
              <dt>Applied by Extract</dt>
              <dd>every frame divided by this map, from frame 0</dd>
              <Show when={f().gainSd !== null}>
                <dt>Gain spread (SD of log gain)</dt>
                <dd>{((f().gainSd ?? 0) * 100).toFixed(1)}%</dd>
              </Show>
            </dl>
          </>
        )}
      </Show>
    </div>
  );
}

/** The Recording tab of a result: what the export says about itself. */
function ResultFacts(props: { result: LoadedResult; origin: ResultOrigin }): JSX.Element {
  const r = () => props.result;
  const m = () => r().meta;
  return (
    <dl class="cala-info" data-testid="result-facts">
      <dt>Recording</dt>
      <dd>{r().label}</dd>
      <Show when={props.origin.session}>
        <dt>Session</dt>
        <dd>{props.origin.session}</dd>
      </Show>
      <Show when={props.origin.run}>
        <dt>Run</dt>
        <dd>{props.origin.run}</dd>
      </Show>
      <dt>Field of view</dt>
      <dd>
        {r().width} x {r().height} px
      </dd>
      <dt>Length</dt>
      <dd>{fmtDuration(r().frames, r().fps)}</dd>
      <dt>Frame rate</dt>
      <dd>{r().fps > 0 ? `${r().fps} Hz` : 'unknown'}</dd>
      <dt>Cells</dt>
      <dd>{r().ids.length}</dd>
      <dt>Written</dt>
      <dd>{String(m().created ?? '')}</dd>
      <dt>App version</dt>
      <dd>{String(m().app_version ?? '')}</dd>
      <dt>Export format</dt>
      <dd>{r().formatVersion}</dd>
      <Show when={props.origin.path}>
        <dt>File</dt>
        <dd>
          <code class="cala-sessions__path">{props.origin.path}</code>
        </dd>
      </Show>
    </dl>
  );
}

export function ResultView(props: { result: LoadedResult; origin: ResultOrigin }): JSX.Element {
  // One result per mount: App remounts the view for another one.
  /* eslint-disable solid/reactivity */
  const result = props.result;
  /* eslint-enable solid/reactivity */
  const runHistory = createRunHistory();
  const ui = createHistoryUi(runHistory);
  const cells = createCellStore(undefined, undefined, runHistory);
  const fps = result.fps > 0 ? result.fps : 20;
  cells.loadResult({
    library: result.library,
    firstSeen: result.firstSeen,
    qc: result.qc,
    frames: result.frames,
    fps,
  });
  runHistory.load({
    bins: result.history?.bins ?? null,
    events: result.history?.events ?? [],
    fps,
  });
  const source = resultFovSource(result);

  // The traces, block by block into the trace viewer's store.
  const [loaded, setLoaded] = createSignal(0);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  let stopped = false;
  onCleanup(() => (stopped = true));
  void (async () => {
    const n = result.ids.length;
    const step = Math.max(1, Math.floor(LOAD_BYTES / (4 * Math.max(1, n))));
    try {
      for (let f = 0; f < result.frames && !stopped; f += step) {
        const to = Math.min(result.frames, f + step);
        const block = await result.readFrames(f, to);
        if (stopped) return;
        cells.onBackfill(false, f, to - f, result.ids, block);
        setLoaded(to);
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  })();

  let main!: HTMLDivElement;
  const layout = createFovLayout(
    () => main,
    () => ({ width: result.width, height: result.height }),
  );
  const [tab, setTab] = createSignal('qc');
  const expanded = () => ui.expanded() && !layout().narrow;
  createEffect(
    on(ui.expanded, (x) => {
      if (x) setTab('history');
    }),
  );
  const fov = () => (
    <FovPanel source={source} cells={cells} width={result.width} height={result.height} fps={fps} />
  );
  const missing = () => [...result.missing].map((p) => PART_LABEL[p]);

  return (
    <div
      ref={main}
      class="cala-main"
      classList={{ 'cala-main--narrow': layout().narrow }}
      style={layout().narrow ? {} : { '--cala-fov-w': `${layout().fovWidth}px` }}
      data-testid="result-view"
    >
      <div class="cala-main__fov">
        <Show when={expanded()} fallback={fov()}>
          <HistoryExpanded ui={ui} />
        </Show>
      </div>
      <div class="cala-main__side">
        <SidePanel id="run" title="Saved result" class="cala-run">
          <p class="cala-muted" data-testid="result-readonly">
            Read-only: this is the result as it was saved. Start a new run from the project to
            Discover, Refine or Extract again.
          </p>
          <Show when={loaded() < result.frames && !loadError()}>
            <ProgressBar
              fraction={result.frames > 0 ? loaded() / result.frames : 1}
              state="running"
              label="Reading traces"
              aria-label="Reading traces"
            />
          </Show>
          <Show when={loadError()}>
            {(e) => (
              <p class="cala-warning" role="alert">
                The traces could not be read: {e()}
              </p>
            )}
          </Show>
          <h3 class="panel-label">Stages that ran</h3>
          <Show
            when={result.stages.length > 0}
            fallback={
              <p class="cala-muted" data-testid="result-stages">
                {result.missing.has('stages')
                  ? `${NOT_IN_EXPORT} (the stage list came with export format 3).`
                  : 'None recorded.'}
              </p>
            }
          >
            <ol class="cala-result__stages" data-testid="result-stages">
              <For each={result.stages}>{(s) => <li>{stageLine(s)}</li>}</For>
            </ol>
          </Show>
          <Show
            when={result.history}
            fallback={
              <p class="cala-muted" data-testid="result-history-missing">
                History: {NOT_IN_EXPORT.toLowerCase()} (the app saves it from export format 4 on).
              </p>
            }
          >
            <div class="cala-run__timeline">
              <RunStrip ui={ui} />
              <Show when={!ui.expanded()}>
                <GroupPlot ui={ui} group="convergence" height={130} compact />
              </Show>
            </div>
          </Show>
          <Show when={missing().length > 0}>
            <p class="cala-muted" data-testid="result-missing">
              {NOT_IN_EXPORT}: {missing().join('; ')}.
            </p>
          </Show>
        </SidePanel>
        <SelectedCellPanel cells={cells} fps={fps} folded={tab() === 'history'} />
        <DetailsTabs
          cells={cells}
          ui={ui}
          active={tab()}
          onActive={setTab}
          fov={() => (expanded() ? fov() : null)}
          flatField={() => <ResultFlatField result={result} />}
          recording={() => <ResultFacts result={result} origin={props.origin} />}
        />
      </div>
    </div>
  );
}
