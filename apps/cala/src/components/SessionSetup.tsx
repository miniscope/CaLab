import { createSignal, For, Index, Show, type JSX } from 'solid-js';
import type { SessionList } from '../lib/session-list.ts';
import {
  DEFAULT_MODE,
  DEFAULT_REFINE_RUNS,
  LIBRARY_MODE_HINT,
  LIBRARY_MODE_LABEL,
  MAX_REFINE_RUNS,
  OFFERED_MODES,
  type LibraryMode,
  type RunSettings,
} from '../lib/session-run.ts';
import { RESULTS_DIR } from '../lib/sessions.ts';
import { isPickerAbort, showPicker, supportsDirectoryPicker } from '../lib/directory-picker.ts';

interface SessionSetupProps {
  list: SessionList;
  /** Open the folder screen to add sessions. */
  onAdd: () => void;
  /** Back to the start screen (the list is dropped). */
  onCancel: () => void;
  /**
   * Start the run. Called inside the Start click, after `readwrite` was
   * granted on the results location (or with null: download a zip).
   */
  onStart: (settings: RunSettings) => void;
  /** Asks for `readwrite` on the location (inside the click); false when refused. */
  grant: () => Promise<boolean>;
}

function fmtStart(ms: number | null): string {
  if (ms === null) return '';
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

/** The session list: review, reorder, remove and add sessions, pick the mode, start. */
export function SessionSetup(props: SessionSetupProps): JSX.Element {
  const [mode, setMode] = createSignal<LibraryMode>(DEFAULT_MODE);
  const [refineRuns, setRefineRuns] = createSignal(DEFAULT_REFINE_RUNS);
  const [startError, setStartError] = createSignal<string | null>(null);
  const l = () => props.list;
  const check = () => l().check();
  const canStart = () =>
    l().items().length > 0 &&
    !l().probing() &&
    check().errors.length === 0 &&
    (!supportsDirectoryPicker() || l().location() !== null);

  async function chooseLocation(): Promise<void> {
    setStartError(null);
    try {
      const handle = await showPicker('readwrite');
      if (handle) l().setLocation({ handle, label: handle.name, chosen: true });
    } catch (err) {
      if (!isPickerAbort(err)) setStartError(err instanceof Error ? err.message : String(err));
    }
  }

  async function start(): Promise<void> {
    setStartError(null);
    try {
      if (!(await props.grant())) {
        setStartError(
          'The browser did not allow writing to the results folder. Choose another folder.',
        );
        return;
      }
      props.onStart({ mode: mode(), refineRuns: refineRuns() });
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div class="import-container cala-open cala-sessions" data-testid="session-setup">
      <div class="app-header">
        <h1 class="app-header__title">Cala</h1>
        <p class="app-header__subtitle">Multi-session run</p>
      </div>

      <section class="cala-sessions__card" aria-labelledby="sessions-title">
        <h2 id="sessions-title" class="cala-sessions__title">
          Sessions <span class="cala-muted">({l().items().length})</span>
        </h2>
        <Show
          when={l().items().length > 0}
          fallback={
            <p class="cala-muted">
              No sessions yet. Add a session folder, or a parent folder: each recording folder in it
              becomes one session.
            </p>
          }
        >
          <ol class="cala-sessions__list" data-testid="session-list">
            <Index each={l().items()}>
              {(s, i) => (
                <li class="cala-sessions__item" data-testid="session-item">
                  <span class="cala-sessions__index">{i + 1}</span>
                  <div class="cala-sessions__body">
                    <strong class="cala-sessions__name">{s().candidate.name}</strong>
                    <span class="cala-sessions__path">
                      {s().candidate.dir || '(selected files)'}
                    </span>
                    <span class="cala-sessions__facts">
                      <Show when={s().info} fallback={s().error ?? 'Reading...'}>
                        {(info) => (
                          <>
                            {info().frameCount.toLocaleString()} frames &middot;{' '}
                            {info().fps !== null ? `${info().fps!.toFixed(2)} fps` : 'fps unknown'}{' '}
                            &middot; {info().width} x {info().height}, {info().bitDepth}-bit
                            &middot; {info().files.length}{' '}
                            {info().files.length === 1 ? 'file' : 'files'}
                          </>
                        )}
                      </Show>
                      <Show when={fmtStart(s().startMs)}>
                        {(t) => <> &middot; started {t()}</>}
                      </Show>
                    </span>
                    <span class="cala-sessions__out">
                      results: {RESULTS_DIR}/{s().resultsPath}
                    </span>
                  </div>
                  <div class="cala-sessions__actions">
                    <button
                      type="button"
                      class="btn-secondary btn-small"
                      aria-label={`Move ${s().candidate.name} up`}
                      disabled={i === 0}
                      onClick={() => l().move(i, i - 1)}
                    >
                      Up
                    </button>
                    <button
                      type="button"
                      class="btn-secondary btn-small"
                      aria-label={`Move ${s().candidate.name} down`}
                      disabled={i === l().items().length - 1}
                      onClick={() => l().move(i, i + 1)}
                    >
                      Down
                    </button>
                    <button
                      type="button"
                      class="btn-secondary btn-small"
                      data-testid="session-remove"
                      aria-label={`Remove ${s().candidate.name}`}
                      onClick={() => l().remove(i)}
                    >
                      Remove
                    </button>
                  </div>
                </li>
              )}
            </Index>
          </ol>
        </Show>
        <p class="cala-sessions__row">
          <button
            type="button"
            class="btn-secondary btn-small"
            data-testid="session-add"
            onClick={() => props.onAdd()}
          >
            Add session
          </button>{' '}
          <button
            type="button"
            class="btn-secondary btn-small"
            disabled={l().items().length < 2}
            title="Order by recording start time (metaData.json), else by path"
            onClick={() => l().sortDefault()}
          >
            Default order
          </button>
          <Show when={l().probing()}>
            <span class="cala-muted" role="status">
              {' '}
              Reading sessions...
            </span>
          </Show>
        </p>
        <For each={check().errors}>
          {(e) => (
            <div class="error-card" role="alert" data-testid="session-error">
              <span>{e}</span>
            </div>
          )}
        </For>
        <For each={check().warnings}>
          {(w) => (
            <p class="cala-sessions__warning" data-testid="session-warning">
              {w}
            </p>
          )}
        </For>
      </section>

      <section class="cala-sessions__card" aria-labelledby="sessions-settings">
        <h2 id="sessions-settings" class="cala-sessions__title">
          Run
        </h2>
        <fieldset class="cala-sessions__modes">
          <legend>Library</legend>
          <For each={OFFERED_MODES}>
            {(m) => (
              <label class="cala-sessions__mode">
                <input
                  type="radio"
                  name="library-mode"
                  value={m}
                  data-testid={`mode-${m}`}
                  checked={mode() === m}
                  onChange={() => setMode(m)}
                />{' '}
                <strong>{LIBRARY_MODE_LABEL[m]}</strong>
                <span class="cala-muted"> {LIBRARY_MODE_HINT[m]}</span>
              </label>
            )}
          </For>
        </fieldset>
        <label class="cala-sessions__row">
          Refine runs before Extract{' '}
          <select
            data-testid="refine-runs"
            value={String(refineRuns())}
            onChange={(e) => setRefineRuns(Number(e.currentTarget.value))}
          >
            <For each={Array.from({ length: MAX_REFINE_RUNS + 1 }, (_, k) => k)}>
              {(k) => <option value={String(k)}>{k}</option>}
            </For>
          </select>
        </label>
        <p class="cala-sessions__row" data-testid="results-location">
          Results:{' '}
          <Show
            when={supportsDirectoryPicker()}
            fallback={
              <span>
                downloaded as one <code>{RESULTS_DIR}.zip</code> when the run ends (this browser
                cannot write to a folder; Chrome and Edge can).
              </span>
            }
          >
            <Show
              when={l().location()}
              fallback={<span>choose a folder (the data folder could not be used).</span>}
            >
              {(loc) => (
                <span>
                  <code>
                    {loc().label}/{RESULTS_DIR}/
                  </code>
                  {loc().chosen ? '' : ' (the data folder)'}
                </span>
              )}
            </Show>{' '}
            <button type="button" class="btn-secondary btn-small" onClick={chooseLocation}>
              Choose...
            </button>
          </Show>
        </p>
        <p class="cala-muted cala-sessions__note">
          Each session's results are written when they are final: an export (.npz) and a metadata
          file in a folder that mirrors the session's path, next to a run manifest. Data folders are
          never written to; an existing results folder is kept and a new, timestamped one is made.
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
            data-testid="sessions-start"
            disabled={!canStart()}
            onClick={() => void start()}
          >
            Start {l().items().length} {l().items().length === 1 ? 'session' : 'sessions'}
          </button>{' '}
          <button type="button" class="btn-secondary" onClick={() => props.onCancel()}>
            Cancel
          </button>
        </p>
      </section>
    </div>
  );
}
