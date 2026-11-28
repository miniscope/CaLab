import { createSignal, For, Show, type JSX } from 'solid-js';
import { ThemeToggle } from '@calab/ui';
import type { ProjectStore } from '../lib/project-store.ts';
import { type IdGroup, type SessionStatus, type StageState } from '../lib/project-index.ts';
import { planSummary } from '@calab/project';
import { LIBRARY_MODE_LABEL } from '../lib/session-run.ts';
import { isPickerAbort, showPicker, supportsDirectoryPicker } from '../lib/directory-picker.ts';
import type { ReadDirLike } from '../lib/project-io.ts';
import type { ProjectResult } from '../lib/project-index.ts';
import { SavedRuns } from './SavedRuns.tsx';
import type { PipelineStore } from '../lib/pipeline-store.ts';
import type { CellStore } from '../lib/cell-store.ts';
import { BoundaryBadge } from './BoundaryBadge.tsx';
import type { ProjectParams } from './RunSettings.tsx';
import { SetupSettings } from './SetupSettings.tsx';
import { errMsg } from '../lib/errors.ts';

interface ProjectViewProps {
  project: ProjectStore;
  /** The pipeline whose settings every run started here reads. */
  pipeline: PipelineStore;
  cells: CellStore;
  /** Saving the settings into the project (Save as project defaults, This session only). */
  projectParams?: ProjectParams;
  /** Back to the start screen. */
  onClose: () => void;
  /** Open a saved result in the read-only viewer (View results). */
  onView?: (result: ProjectResult) => void;
  /** Run a one-session project (inside the click: write permission is asked for first). */
  onRun: () => void;
  /** Start the plan of a project of several sessions (inside the click). Resolves false when writing was refused. */
  onStartPlan: () => Promise<boolean>;
  /** A run was asked for and its recording or stream is being opened. */
  starting: boolean;
  /** Why the last Run did not start, or its recording or stream could not be opened (null: none). */
  runError: string | null;
}

/** One frame width and rate shared by `infos` (0 where they differ or are unknown). */
export function sharedFormat(infos: readonly ({ width: number; fps: number | null } | null)[]): {
  width: number;
  fps: number;
} {
  const known = infos.filter((i): i is { width: number; fps: number | null } => i !== null);
  if (known.length === 0) return { width: 0, fps: 0 };
  const same = <T,>(xs: T[]): T | null => (xs.every((x) => x === xs[0]) ? xs[0] : null);
  return {
    width: same(known.map((i) => i.width)) ?? 0,
    fps: same(known.map((i) => i.fps ?? 0)) ?? 0,
  };
}

/** A run id (`2026-11-13_14-02-33`) as `11-13 14:02`; other ids as they are. */
export function fmtRun(id: string): string {
  const m = /^(legacy-)?\d{4}-(\d{2})-(\d{2})_(\d{2})-(\d{2})-\d{2}(_\d+)?$/.exec(id);
  return m ? `${m[1] ? 'legacy ' : ''}${m[2]}-${m[3]} ${m[4]}:${m[5]}${m[6] ?? ''}` : id;
}

export function fmtDate(iso: string | null, short = false): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return short
    ? d.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
    : d.toLocaleString();
}

/** `800 frames, 0:40` (the duration when the rate is known). */
export function fmtLength(frames: number | null, fps: number | null): string {
  if (frames === null) return '';
  const f = `${frames.toLocaleString()} frames`;
  if (!fps) return f;
  const s = Math.round(frames / fps);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return `${f}, ${h > 0 ? `${h}:${String(m).padStart(2, '0')}` : m}:${ss}`;
}

const STATE_TEXT: Record<StageState, string> = {
  done: 'done',
  error: 'error',
  cancelled: 'cancelled',
  running: 'not finished',
  skipped: 'skipped (Discover only)',
  none: '—',
};

/** The words in a stage cell. */
export function stageText(st: SessionStatus, stage: 'discover' | 'extract'): string {
  return STATE_TEXT[st[stage]];
}

/**
 * The setup page (`docs/projects.md`): every project opens here, a single recording or a live
 * stream as a project of one session. The sessions with their cala status and results, the
 * settings every run reads, and Run (one session) or the run plan (several). Run opens the run
 * page, which starts at once.
 */
export function ProjectView(props: ProjectViewProps): JSX.Element {
  const p = () => props.project;
  /** A project of one session (a single recording or a live stream): Run, no plan to build. */
  const single = () => p().single() !== null;
  const format = () =>
    sharedFormat(
      p()
        .rows()
        .map((r) => r.planned.info),
    );
  const [details, setDetails] = createSignal<string | null>(null);
  const [startError, setStartError] = createSignal<string | null>(null);
  const rows = () => p().tableRows();
  const idGroups = (): Map<string, IdGroup> => p().idGroups();
  const idGroup = (id: string) => idGroups().get(id) ?? null;
  const selectable = () => rows().filter((r) => r.row !== null);
  const allSelected = () =>
    selectable().length > 0 && selectable().every((r) => p().selected().has(r.session.id));

  async function chooseResults(): Promise<void> {
    setStartError(null);
    try {
      const h = await showPicker('readwrite');
      if (h) await p().useResultsFolder(h as unknown as ReadDirLike);
    } catch (err) {
      if (!isPickerAbort(err)) setStartError(errMsg(err));
    }
  }

  async function start(): Promise<void> {
    setStartError(null);
    try {
      if (!(await props.onStartPlan()))
        setStartError('The browser did not allow writing to the results folder.');
    } catch (err) {
      setStartError(errMsg(err));
    }
  }

  return (
    <div class="import-container cala-open cala-project" data-testid="project-view">
      <div class="app-header cala-app-header">
        <h1 class="app-header__title">Cala</h1>
        <ThemeToggle />
        <p class="app-header__subtitle">
          Project <strong data-testid="project-name">{p().opened()?.rootName}</strong>
        </p>
      </div>

      <section class="cala-sessions__card cala-project__card" aria-labelledby="project-sessions">
        <h2 id="project-sessions" class="cala-sessions__title">
          Sessions <span class="cala-muted">({rows().length})</span>
        </h2>
        <p class="cala-sessions__row cala-project__where" data-testid="project-results">
          Results: <code>{p().location().label}/</code>
          {p().location().kind === 'default' ? ' (next to the data)' : ' (chosen folder)'}{' '}
          <Show when={supportsDirectoryPicker() && p().canWrite()}>
            <button type="button" class="btn-secondary btn-small" onClick={chooseResults}>
              Choose another folder...
            </button>
          </Show>
          <Show when={!p().canWrite()}>
            <span class="cala-muted">
              {' '}
              {p().declined()
                ? 'Writing to the folder was declined'
                : 'This browser cannot write to the folder'}
              : each run downloads a zip of its run folder. Until then the project file and the run
              file are saved in browser storage.
            </span>
          </Show>
        </p>
        <SavedRuns project={p()} />
        <Show when={p().loading()}>
          <p class="cala-muted" role="status">
            Reading sessions...
          </p>
        </Show>
        <For each={p().warnings()}>
          {(w) => (
            <p class="cala-sessions__warning" data-testid="project-warning">
              {w}
            </p>
          )}
        </For>
        <Show when={p().error()}>
          {(m) => (
            <div class="error-card" role="alert" data-testid="project-error">
              <span>{m()}</span>
            </div>
          )}
        </Show>

        <div class="cala-project__scroll">
          <table class="cala-project__table" data-testid="project-table">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    aria-label="Select all sessions"
                    data-testid="select-all"
                    checked={allSelected()}
                    onChange={(e) => p().selectAll(e.currentTarget.checked)}
                  />
                </th>
                <th>Session</th>
                <th>Date</th>
                <th>Length</th>
                <th>Discover</th>
                <th>Extract</th>
                <th title="Sessions with the same letter share cell ids (one Joint run): cell 7 is the same neuron in each">
                  Cell IDs
                </th>
                <th>Library</th>
                <th>Current result</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <For each={rows()}>
                {(r) => (
                  <>
                    <tr
                      data-testid="project-row"
                      data-session={r.session.id}
                      classList={{
                        'cala-project__row--missing': r.session.missing,
                        'cala-project__row--selected': p().selected().has(r.session.id),
                        [`cala-project__row--ids${(idGroup(r.session.id)?.colour ?? -1) % 6}`]:
                          (idGroup(r.session.id)?.colour ?? -1) >= 0,
                      }}
                    >
                      <td>
                        <input
                          type="checkbox"
                          data-testid="row-select"
                          aria-label={`Select ${r.session.id}`}
                          disabled={r.row === null}
                          checked={p().selected().has(r.session.id)}
                          onChange={(e) => p().toggle(r.session.id, e.currentTarget.checked)}
                        />
                      </td>
                      <td class="cala-project__session">
                        {r.session.id}
                        <Show when={p().hasOwnParams(r.session.id)}>
                          <span
                            class="cala-muted"
                            data-testid="row-own-settings"
                            title="This session has settings of its own in the project file: its runs use them over the project's defaults (values set on this page still win)."
                          >
                            {' '}
                            (own settings)
                          </span>
                        </Show>
                        <Show when={r.session.missing}>
                          <span class="cala-muted"> (folder missing)</span>
                        </Show>
                        <Show when={r.row?.planned.error}>
                          {(e) => <span class="cala-sessions__warning"> {e()}</span>}
                        </Show>
                        <Show when={r.status.boundary}>
                          {(f) => (
                            <>
                              {' '}
                              <BoundaryBadge
                                flag={f()}
                                {...(r.status.runMode === 'joint'
                                  ? { onSeparate: () => p().replanSeparate(r.status.runSessions) }
                                  : {})}
                              />
                            </>
                          )}
                        </Show>
                      </td>
                      <td>{fmtDate(r.session.start, true)}</td>
                      <td>{fmtLength(r.session.frames, r.session.fps)}</td>
                      <td data-testid="cell-discover">{stageText(r.status, 'discover')}</td>
                      <td data-testid="cell-extract">{stageText(r.status, 'extract')}</td>
                      <td data-testid="cell-ids">
                        <Show when={idGroup(r.session.id)} fallback={'\u2014'}>
                          {(g) => (
                            <Show
                              when={g().label}
                              fallback={
                                <span
                                  class="cala-muted"
                                  title="A Separate run: this session's own cell ids (matching across sessions comes later)"
                                >
                                  own
                                </span>
                              }
                            >
                              <span
                                class={`cala-project__ids cala-project__ids--${g().colour % 6}`}
                                title={`Shares cell ids with: ${g()
                                  .sessions.filter((x) => x !== r.session.id)
                                  .join(', ')}`}
                              >
                                {g().label}
                              </span>{' '}
                              <span class="cala-muted">shared by {g().sessions.length}</span>
                            </Show>
                          )}
                        </Show>
                      </td>
                      <td class="cala-muted" title="Saved libraries come in a later version">
                        {'—'}
                      </td>
                      <td class="cala-project__wrap" data-testid="cell-current">
                        <Show
                          when={r.status.current}
                          fallback={<span class="cala-muted">{r.status.note ?? '—'}</span>}
                        >
                          {(c) => (
                            <>
                              <span title={`run ${c().run}`}>run {fmtRun(c().run)}</span>
                              <span class="cala-muted">
                                {c().cells !== null ? `, ${c().cells} cells` : ''}
                              </span>{' '}
                              <Show when={props.onView}>
                                <button
                                  type="button"
                                  class="btn-secondary btn-small"
                                  data-testid="view-current"
                                  title="Open this result in the viewer (read-only)"
                                  onClick={() => props.onView?.(c())}
                                >
                                  View results
                                </button>
                              </Show>
                            </>
                          )}
                        </Show>
                      </td>
                      <td>
                        <Show when={r.status.results.length > 0 || r.status.run}>
                          <button
                            type="button"
                            class="btn-secondary btn-small"
                            data-testid="row-details"
                            aria-expanded={details() === r.session.id}
                            onClick={() =>
                              setDetails(details() === r.session.id ? null : r.session.id)
                            }
                          >
                            Results
                          </button>
                        </Show>
                      </td>
                    </tr>
                    <Show when={details() === r.session.id}>
                      <tr class="cala-project__details" data-testid="row-details-panel">
                        <td colSpan={11}>
                          <Show
                            when={r.status.results.length > 0}
                            fallback={<span class="cala-muted">No results yet.</span>}
                          >
                            <ul class="cala-project__results">
                              <For each={r.status.results}>
                                {(res) => (
                                  <li data-testid="result-item">
                                    <strong title={res.run}>run {fmtRun(res.run)}</strong>
                                    {res.current ? ' (current)' : ''}{' '}
                                    <span class="cala-muted">
                                      {fmtDate(res.created)}
                                      {res.cells !== null ? `, ${res.cells} cells` : ''}
                                    </span>{' '}
                                    <code class="cala-sessions__path">
                                      {p().location().label}/{res.export_path}
                                    </code>{' '}
                                    <Show when={props.onView}>
                                      <button
                                        type="button"
                                        class="btn-secondary btn-small"
                                        data-testid="view-result"
                                        title="Open this result in the viewer (read-only)"
                                        onClick={() => props.onView?.(res)}
                                      >
                                        View results
                                      </button>{' '}
                                    </Show>
                                    <Show when={!res.current}>
                                      <button
                                        type="button"
                                        class="btn-secondary btn-small"
                                        data-testid="set-current"
                                        onClick={() => void p().setCurrent(r.session.id, res.run)}
                                      >
                                        Set current
                                      </button>
                                    </Show>
                                  </li>
                                )}
                              </For>
                            </ul>
                          </Show>
                        </td>
                      </tr>
                    </Show>
                  </>
                )}
              </For>
            </tbody>
          </table>
        </div>
        <Show when={!single()}>
          <p class="cala-sessions__row">
            <button
              type="button"
              class="btn-secondary btn-small"
              data-testid="plan-chain"
              disabled={p().selected().size < 2}
              title="One Joint run through the selected sessions in order: one set of cells, so cell ids match across them"
              onClick={() => p().addToPlan('joint')}
            >
              Run selected jointly
            </button>{' '}
            <button
              type="button"
              class="btn-secondary btn-small"
              data-testid="plan-separate"
              disabled={p().selected().size === 0}
              title="Each selected session gets its own Discover and Extract"
              onClick={() => p().addToPlan('separate')}
            >
              Run selected separately
            </button>{' '}
            <span class="cala-muted">{p().selected().size} selected</span>
          </p>
        </Show>
      </section>

      <SetupSettings
        pipeline={props.pipeline}
        cells={props.cells}
        projectParams={props.projectParams}
        frameWidth={format().width}
        fps={format().fps}
        live={p().opened()?.live !== undefined}
        sessions={p().rows().length}
      />

      <Show when={single()}>
        <section class="cala-sessions__card cala-project__card" aria-label="Run">
          <Show when={props.runError}>
            {(m) => (
              <div class="error-card" role="alert" data-testid="run-refused">
                <span>{m()}</span>
              </div>
            )}
          </Show>
          <div class="cala-project__run">
            <button
              type="button"
              class="btn-primary"
              data-testid="run-start"
              disabled={props.starting || p().loading() || p().planErrors().length > 0}
              title={p().planErrors()[0] ?? 'Run Discover and Extract with these settings'}
              onClick={() => props.onRun()}
            >
              {props.starting ? 'Opening...' : 'Run'}
            </button>
            <button
              type="button"
              class="btn-secondary"
              data-testid="project-close"
              onClick={() => props.onClose()}
            >
              Close project
            </button>
          </div>
        </section>
      </Show>

      <Show when={!single()}>
        <section class="cala-sessions__card cala-project__card" aria-labelledby="project-plan">
          <h2 id="project-plan" class="cala-sessions__title">
            Run plan{' '}
            <span class="cala-muted">
              {p().plan().length > 0 ? `(${planSummary(p().plan())})` : ''}
            </span>
          </h2>
          <Show
            when={p().plan().length > 0}
            fallback={
              <p class="cala-muted">
                Select sessions above, then <strong>Run selected jointly</strong> (one Joint run,
                one library across them) or <strong>Run selected separately</strong> (one run each).
                Steps run one after another.
              </p>
            }
          >
            <ol class="cala-sessions__list" data-testid="plan-list">
              <For each={p().plan()}>
                {(g, i) => (
                  <li class="cala-sessions__item" data-testid="plan-group">
                    <span class="cala-sessions__index">{i() + 1}</span>
                    <div class="cala-sessions__body">
                      <strong>
                        {g.kind === 'joint'
                          ? `${LIBRARY_MODE_LABEL.joint}: ${g.streams.length} sessions`
                          : `${LIBRARY_MODE_LABEL.separate}: ${g.streams.length} ${g.streams.length === 1 ? 'session' : 'sessions'}`}
                      </strong>
                      <span class="cala-sessions__path">{g.streams.join(', ')}</span>
                    </div>
                    <div class="cala-sessions__actions">
                      <button
                        type="button"
                        class="btn-secondary btn-small"
                        aria-label={`Move step ${i() + 1} up`}
                        disabled={i() === 0}
                        onClick={() => p().moveGroup(i(), i() - 1)}
                      >
                        Up
                      </button>
                      <button
                        type="button"
                        class="btn-secondary btn-small"
                        data-testid="plan-remove"
                        aria-label={`Remove step ${i() + 1}`}
                        onClick={() => p().removeGroup(i())}
                      >
                        Remove
                      </button>
                    </div>
                  </li>
                )}
              </For>
            </ol>
          </Show>
          <For each={p().planErrors()}>
            {(e) => (
              <div class="error-card" role="alert" data-testid="plan-error">
                <span>{e}</span>
              </div>
            )}
          </For>
          <Show when={p().planState().kind === 'stopped'}>
            <p class="cala-sessions__warning" data-testid="plan-stopped">
              The last plan stopped: {(p().planState() as { reason?: string }).reason ?? ''}.
              Results already written are kept; the steps not finished are left in the plan.
            </p>
          </Show>
          <p class="cala-muted cala-sessions__note">
            Each step is one run, written to <code>{p().location().label}/runs/&lt;run&gt;/</code>{' '}
            as each session finishes; that session's newest result becomes its current one. Data
            folders are only read.
          </p>
          <Show when={startError() ?? props.runError}>
            {(m) => (
              <div class="error-card" role="alert" data-testid="run-refused">
                <span>{m()}</span>
              </div>
            )}
          </Show>
          <p class="cala-sessions__row">
            <button
              type="button"
              class="btn-primary"
              data-testid="plan-start"
              disabled={
                props.starting ||
                p().plan().length === 0 ||
                p().planErrors().length > 0 ||
                p().loading()
              }
              onClick={() => void start()}
            >
              {props.starting ? 'Opening...' : 'Run plan'}
            </button>{' '}
            <Show when={p().plan().length > 0}>
              <button type="button" class="btn-secondary" onClick={() => p().clearPlan()}>
                Clear plan
              </button>{' '}
            </Show>
            <button
              type="button"
              class="btn-secondary"
              data-testid="project-close"
              onClick={() => props.onClose()}
            >
              Close project
            </button>
          </p>
        </section>
      </Show>
    </div>
  );
}
