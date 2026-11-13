import { createSignal, For, Show, type JSX } from 'solid-js';
import { ImportFeedbackLinks } from '@calab/community-ui';
import { filesFromDrop } from '../lib/dropped-files.ts';
import { entriesFromFiles, type FolderEntry } from '../lib/frame-source.ts';
import { detectSeries, entriesForSeries, seriesLabel } from '../lib/video-series.ts';
import {
  pickDirectoryWithHandle,
  supportsDirectoryPicker,
  type DirHandleLike,
} from '../lib/directory-picker.ts';
import {
  chooseKind,
  groupKinds,
  sessionsForKind,
  type SeriesKind,
  type SessionCandidate,
} from '../lib/sessions.ts';

interface OpenFolderProps {
  loading: boolean;
  error: string | null;
  /** Called with every file picked or dropped, and a label for the header. */
  onOpen: (entries: FolderEntry[], label: string) => void;
  /** Connect to a live source (a WebSocket URL, see `lib/live-source.ts`). */
  onOpenLive?: (url: string) => void;
  /** The URL offered in the live-source field. */
  liveUrl?: string;
  /**
   * More than one session found (a parent folder of several recordings), or
   * the user asked for the session list: review them before a multi-session
   * run. `handle` is the picked folder (File System Access API), if any.
   */
  onSessions?: (sessions: SessionCandidate[], handle: DirHandleLike | null) => void;
  /** Label of the add button when this screen adds sessions to a list. */
  addMode?: boolean;
  onCancel?: () => void;
}

/** Sessions found in the picked or dropped files (see `lib/sessions.ts`). */
export interface FoundSessions {
  sessions: SessionCandidate[];
  handle: DirHandleLike | null;
}

/**
 * Example address shown in the empty live-source field. The field starts
 * empty: a live source is optional (the simulator, `npm run sim-stream`,
 * listens on ws://localhost:8765).
 */
export const LIVE_URL_PLACEHOLDER = 'ws://host:port';

/** Where the simulated stream (`npm run sim-stream`) is documented. */
export const LIVE_HELP_URL =
  'https://github.com/miniscope/CaLab/blob/main/apps/cala/USER_GUIDE.md#testing-with-a-simulated-stream';

/** The folder name for the header: the picked directory, else the first file's name. */
function labelFor(entries: FolderEntry[]): string {
  const rel = entries[0].relPath;
  if (rel.includes('/')) return rel.split('/')[0];
  // Files picked one by one: name the recording by its first video.
  const video = entries.find((e) => e.file.name.toLowerCase().endsWith('.avi')) ?? entries[0];
  const others = entries.length - 1;
  return others > 0
    ? `${video.file.name} + ${others} file${others > 1 ? 's' : ''}`
    : video.file.name;
}

/** First screen: pick or drop a Miniscope recording folder. */
export function OpenFolder(props: OpenFolderProps): JSX.Element {
  const [dragging, setDragging] = createSignal(false);
  // The offered URL seeds the field once; the user edits it from there.
  // eslint-disable-next-line solid/reactivity
  const [liveUrl, setLiveUrl] = createSignal(props.liveUrl ?? '');
  let folderInput!: HTMLInputElement;
  let filesInput!: HTMLInputElement;

  const [pickError, setPickError] = createSignal<string | null>(null);

  // Several plausible video series in the selection: ask which one to open.
  const [pending, setPending] = createSignal<{
    entries: FolderEntry[];
    handle: DirHandleLike | null;
    candidates: SeriesKind[];
  } | null>(null);
  let chooserHeading: HTMLHeadingElement | undefined;

  /**
   * Open what was picked. The video series are grouped into kinds (the
   * Miniscope of each session, a behaviour camera, ...; `lib/sessions.ts`).
   * One session opens as before; several go to the session list; several
   * plausible kinds ask the user first.
   */
  const submit = (entries: FolderEntry[], handle: DirHandleLike | null = null) => {
    if (entries.length === 0) return;
    const kinds = groupKinds(detectSeries(entries));
    const { chosen, candidates } = chooseKind(kinds);
    if (chosen) {
      openKind(entries, handle, chosen);
      return;
    }
    if (candidates.length === 0) {
      setPending(null);
      if (props.addMode) props.onSessions?.([], handle);
      else props.onOpen(entries, labelFor(entries));
      return;
    }
    setPending({ entries, handle, candidates });
    queueMicrotask(() => chooserHeading?.focus());
  };

  function openKind(entries: FolderEntry[], handle: DirHandleLike | null, kind: SeriesKind) {
    setPending(null);
    const sessions = sessionsForKind(entries, kind);
    if ((sessions.length > 1 || props.addMode) && props.onSessions) {
      props.onSessions(sessions, handle);
      return;
    }
    // One session: open it as a plain folder, as before multi-session runs.
    const all = detectSeries(entries);
    const chosen = kind.series.length === 1 && all.length > 1 ? kind.series[0] : null;
    props.onOpen(chosen ? entriesForSeries(entries, all, chosen) : entries, labelFor(entries));
  }

  const choose = (picked: SeriesKind) => {
    const p = pending();
    if (!p) return;
    openKind(p.entries, p.handle, picked);
  };

  // Chrome and Edge: the read-only directory picker ("view files"). Elsewhere
  // the hidden webkitdirectory input, whose prompt says "upload".
  const openFolder = () => {
    setPickError(null);
    if (!supportsDirectoryPicker()) {
      folderInput.click();
      return;
    }
    pickDirectoryWithHandle().then(
      (picked) => {
        if (picked) submit(picked.entries, picked.handle);
      },
      (err: unknown) => {
        setPickError(`Could not open the folder: ${err instanceof Error ? err.message : err}`);
      },
    );
  };

  return (
    <div class="import-container cala-open">
      <div class="app-header">
        <h1 class="app-header__title">Cala</h1>
        <p class="app-header__subtitle">
          Streaming calcium imaging from raw 1-photon Miniscope video
        </p>
      </div>

      <div class="drop-zone-wrapper">
        <div
          class="drop-zone"
          classList={{ 'drop-zone--active': dragging() }}
          role="button"
          tabindex="0"
          aria-label="Open a Miniscope folder"
          onClick={openFolder}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              openFolder();
            }
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            if (e.dataTransfer) void filesFromDrop(e.dataTransfer).then(submit);
          }}
        >
          <p class="drop-zone__text">
            <strong>{props.addMode ? 'Add a session folder' : 'Open a Miniscope folder'}</strong> or
            drop it here
          </p>
          <p class="drop-zone__subtext">
            The folder with the numbered videos (0.avi, 1.avi, ... or msCam0.avi, msCam1.avi, ...)
            and metaData.json, timeStamps.csv, or a parent folder of several sessions (each
            recording folder becomes one session). Videos are read frame by frame from disk, never
            loaded whole, and never uploaded.
          </p>
        </div>
        <input
          ref={folderInput}
          type="file"
          class="cala-hidden-input"
          data-testid="folder-input"
          // @ts-expect-error webkitdirectory is not in lib.dom's input attributes
          webkitdirectory=""
          multiple
          onChange={(e) => {
            submit(entriesFromFiles(Array.from(e.currentTarget.files ?? [])));
            e.currentTarget.value = '';
          }}
        />
        <input
          ref={filesInput}
          type="file"
          class="cala-hidden-input"
          data-testid="files-input"
          multiple
          accept=".avi,.json,.csv"
          onChange={(e) => {
            submit(entriesFromFiles(Array.from(e.currentTarget.files ?? [])));
            e.currentTarget.value = '';
          }}
        />
      </div>

      <p class="file-info">
        <button type="button" class="btn-secondary btn-small" onClick={() => filesInput.click()}>
          Choose individual files
        </button>
        <Show when={props.onSessions && !props.addMode}>
          {' '}
          <button
            type="button"
            class="btn-secondary btn-small"
            data-testid="multi-session"
            title="Run several sessions of one animal, with one footprint library across them or one per session"
            onClick={() => props.onSessions?.([], null)}
          >
            Multi-session run
          </button>
        </Show>
        <Show when={props.addMode && props.onCancel}>
          {' '}
          <button
            type="button"
            class="btn-secondary btn-small"
            data-testid="add-cancel"
            onClick={() => props.onCancel?.()}
          >
            Back to the session list
          </button>
        </Show>
      </p>
      <p class="file-info" data-testid="local-note">
        Files are read locally and never leave your computer.
      </p>

      <Show when={props.onOpenLive}>
        <form
          class="file-info cala-live-open"
          onSubmit={(e) => {
            e.preventDefault();
            const url = liveUrl().trim();
            if (url) props.onOpenLive?.(url);
          }}
        >
          <label>
            Optional: stream from a live source{' '}
            <input
              type="text"
              class="cala-live-open__url"
              data-testid="live-url"
              value={liveUrl()}
              onInput={(e) => setLiveUrl(e.currentTarget.value)}
              placeholder={LIVE_URL_PLACEHOLDER}
              spellcheck={false}
            />
          </label>{' '}
          <button type="submit" class="btn-secondary btn-small" data-testid="live-connect">
            Connect
          </button>{' '}
          <a href={LIVE_HELP_URL} target="_blank" rel="noopener" data-testid="live-help">
            How to test with a simulated stream
          </a>
        </form>
      </Show>

      <Show when={pending()}>
        {(p) => (
          <section
            class="cala-series-chooser"
            data-testid="series-chooser"
            aria-labelledby="series-chooser-title"
          >
            <h2
              id="series-chooser-title"
              class="cala-series-chooser__title"
              tabindex="-1"
              ref={chooserHeading}
            >
              More than one video series found. Which is the Miniscope recording?
            </h2>
            <ul class="cala-series-chooser__list">
              <For each={p().candidates}>
                {(s) => (
                  <li>
                    <button
                      type="button"
                      class="btn-secondary cala-series-chooser__option"
                      data-testid="series-option"
                      onClick={() => choose(s)}
                    >
                      <Show
                        when={s.series.length > 1}
                        fallback={
                          <>
                            <strong>{seriesLabel(s.series[0])}</strong> {'\u2014'} {s.files}{' '}
                            {s.files === 1 ? 'file' : 'files'}
                            <span class="cala-series-chooser__dir">
                              {s.series[0].dir === '' ? '(selected files)' : s.series[0].dir}
                            </span>
                          </>
                        }
                      >
                        <strong>{s.label}</strong> {'\u2014'} {s.series.length} sessions, {s.files}{' '}
                        files
                        <span class="cala-series-chooser__dir">
                          {s.series.map((x) => x.dir).join(', ')}
                        </span>
                      </Show>
                    </button>
                  </li>
                )}
              </For>
            </ul>
            <button
              type="button"
              class="btn-secondary btn-small"
              data-testid="series-cancel"
              onClick={() => setPending(null)}
            >
              Cancel
            </button>
          </section>
        )}
      </Show>

      <Show when={props.loading}>
        <p class="file-info" role="status">
          Opening...
        </p>
      </Show>
      <Show when={pickError() ?? props.error}>
        {(message) => (
          <div class="error-card" role="alert">
            <span>{message()}</span>
          </div>
        )}
      </Show>

      <ImportFeedbackLinks appId={__APP_ID__} />
    </div>
  );
}
