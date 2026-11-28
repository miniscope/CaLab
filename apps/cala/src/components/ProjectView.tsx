import { createSignal, For, Show, type JSX } from 'solid-js';
import { ThemeToggle } from '@calab/ui';
import type { ProjectStore } from '../lib/project-store.ts';
import { type IdGroup, type SessionStatus, type StageState } from '../lib/project-index.ts';
import { planSummary } from '@calab/project';
import { LIBRARY_MODE_LABEL } from '../lib/session-run.ts';
import { isPickerAbort, showPicker, supportsDirectoryPicker } from '../lib/directory-picker.ts';
import type { ReadDirLike } from '../lib/project-io.ts';
import type { ProjectResult } from '../lib/project-index.ts';
import type { PipelineStore } from '../lib/pipeline-store.ts';
import { BoundaryBadge } from './BoundaryBadge.tsx';
import { DiscoverSettings } from './DiscoverSettings.tsx';
import { errMsg } from '../lib/errors.ts';

interface ProjectViewProps {
  project: ProjectStore;
  /** The pipeline whose start-time settings (Look-back, Final settle) the plan's runs use. */
  pipeline?: PipelineStore;
  /** Back to the start screen. */
  onClose: () => void;
  /** Open a saved result in the read-only viewer (View results). */
  onView?: (result: ProjectResult) => void;
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
  none: '—',
};

/** The words in a stage cell. */
export function stageText(st: SessionStatus, stage: 'discover' | 'extract'): string {
  return STATE_TEXT[st[stage]];
}

/** The project view: the animal's sessions, their cala status, and the run plan. */
export function ProjectView(props: ProjectViewProps): JSX.Element {
  const p = () => props.project;
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
      if (!(await p().startPlan()))
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
              : each run downloads a zip of its run folder, and changes to the index are not saved.
            </span>
          </Show>
        </p>
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
      </section>

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
              Select sessions above, then <strong>Run selected jointly</strong> (one Joint run, one
              library across them) or <strong>Run selected separately</strong> (one run each). Steps
              run one after another.
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
        <Show when={props.pipeline}>
          {(pl) => (
            <fieldset class="cala-sessions__modes" data-testid="setup-discover-settings">
              <legend>Discover settings (every run in the plan)</legend>
              <DiscoverSettings pipeline={pl()} context="setup" />
            </fieldset>
          )}
        </Show>
        <Show when={p().planState().kind === 'stopped'}>
          <p class="cala-sessions__warning" data-testid="plan-stopped">
            The last plan stopped: {(p().planState() as { reason?: string }).reason ?? ''}. Results
            already written are kept; the steps not finished are left in the plan.
          </p>
        </Show>
        <p class="cala-muted cala-sessions__note">
          Each step is one run, written to <code>{p().location().label}/runs/&lt;run&gt;/</code> as
          each session finishes; that session's newest result becomes its current one. Data folders
          are only read.
        </p>
        <Show when={startError()}>
          {(m) => (
            <div class="error-card" role="alert">
              <span>{m()}</span>
            </div>
          )}
        </Show>
        <p class="cala-sessions__row">
          <button
            type="button"
            class="btn-primary"
            data-testid="plan-start"
            disabled={p().plan().length === 0 || p().planErrors().length > 0 || p().loading()}
            onClick={() => void start()}
          >
            Start plan
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
    </div>
  );
}
