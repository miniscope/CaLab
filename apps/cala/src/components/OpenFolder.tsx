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
import {
  PROJECT_INDEX_FILE,
  projectSessionId,
  suggestSplit,
  type SplitGroup,
} from '../lib/project-index.ts';
import type { ProjectOpen } from '../lib/project-store.ts';
import type { ReadDirLike } from '../lib/project-io.ts';
import { ensureRead, type RecentProject } from '../lib/recent-projects.ts';
import { entriesFromDirectoryHandle } from '../lib/directory-picker.ts';
import { RESULTS_DIR } from '../lib/sessions.ts';

/** The files of one top-level subfolder, re-rooted so that subfolder is the picked folder. */
export function subfolderEntries(entries: FolderEntry[], root: string, sub: string): FolderEntry[] {
  const prefix = `${root}/${sub}/`;
  return entries
    .filter((e) => e.relPath.startsWith(prefix))
    .map((e) => ({ file: e.file, relPath: e.relPath.slice(root.length + 1) }));
}

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
  /** Open an animal folder as a project (`docs/projects.md`). */
  onProject?: (open: ProjectOpen) => void;
  /** Several animals in the picked folder, opened one by one: remember the others. */
  onAnimals?: (handles: ReadDirLike[]) => void;
  /** Recent projects (Chrome, Edge), most recent first. */
  recent?: RecentProject[];
  onForget?: (r: RecentProject) => void;
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
  let projectInput!: HTMLInputElement;

  const [pickError, setPickError] = createSignal<string | null>(null);

  // Several plausible video series in the selection: ask which one to open.
  const [pending, setPending] = createSignal<{
    entries: FolderEntry[];
    handle: DirHandleLike | null;
    candidates: SeriesKind[];
    /** Picked with "Open animal project". */
    project?: boolean;
  } | null>(null);
  // An experiment folder of several animals: which one to open.
  const [split, setSplit] = createSignal<{
    entries: FolderEntry[];
    handle: DirHandleLike | null;
    sessions: SessionCandidate[];
    groups: SplitGroup[];
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

  function openKind(
    entries: FolderEntry[],
    handle: DirHandleLike | null,
    kind: SeriesKind,
    project = false,
  ) {
    setPending(null);
    if (project) {
      openProject(entries, handle, sessionsForKind(entries, kind));
      return;
    }
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
    openKind(p.entries, p.handle, picked, p.project);
  };

  /** A results folder chosen earlier for the project being reopened. */
  let reopenResults: ReadDirLike | null = null;

  /** Reopen a recent project: permission again (inside the click), then as if picked. */
  async function reopen(r: RecentProject) {
    setPickError(null);
    try {
      if (!(await ensureRead(r.handle))) {
        setPickError(
          `The browser did not allow reading ${r.name}. Open it with "Open animal project".`,
        );
        return;
      }
      reopenResults =
        r.resultsHandle && (await ensureRead(r.resultsHandle))
          ? (r.resultsHandle as ReadDirLike)
          : null;
      const handle = r.handle as DirHandleLike;
      submitProject(await entriesFromDirectoryHandle(handle), handle);
    } catch (err) {
      setPickError(
        `Could not open ${r.name} (moved or deleted?): ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  const rootOf = (entries: FolderEntry[]) => entries[0]?.relPath.split('/')[0] ?? '';

  /**
   * "Open animal project": the picked folder is the animal. A folder that
   * holds several animals (and no project index of its own) is offered as
   * one project per animal first.
   */
  const submitProject = (entries: FolderEntry[], handle: DirHandleLike | null = null) => {
    setSplit(null);
    setPending(null);
    if (entries.length === 0) return;
    const kinds = groupKinds(detectSeries(entries));
    const { chosen, candidates } = chooseKind(kinds);
    if (chosen) {
      openKind(entries, handle, chosen, true);
      return;
    }
    if (candidates.length === 0) {
      setPickError('No Miniscope recordings were found in this folder.');
      return;
    }
    setPending({ entries, handle, candidates, project: true });
    queueMicrotask(() => chooserHeading?.focus());
  };

  function openProject(
    entries: FolderEntry[],
    handle: DirHandleLike | null,
    sessions: SessionCandidate[],
  ) {
    const root = rootOf(entries);
    const hasIndex = entries.some(
      (e) => e.relPath === `${root}/${RESULTS_DIR}/${PROJECT_INDEX_FILE}`,
    );
    const groups = hasIndex ? null : suggestSplit(sessions.map((s) => projectSessionId(s.dir)));
    if (groups) {
      setSplit({ entries, handle, sessions, groups });
      return;
    }
    props.onProject?.({
      rootName: root,
      entries,
      handle: handle as unknown as ReadDirLike | null,
      sessions,
      resultsHandle: reopenResults,
    });
    reopenResults = null;
  }

  /** Open one animal of a split folder (and remember the others). */
  async function openAnimal(sub: string | null) {
    const sp = split();
    if (!sp) return;
    setSplit(null);
    if (sub === null) {
      props.onProject?.({
        rootName: rootOf(sp.entries),
        entries: sp.entries,
        handle: sp.handle as unknown as ReadDirLike | null,
        sessions: sp.sessions,
      });
      return;
    }
    const root = rootOf(sp.entries);
    const entries = subfolderEntries(sp.entries, root, sub);
    const parent = sp.handle as unknown as ReadDirLike | null;
    let handle: ReadDirLike | null = null;
    try {
      if (parent?.getDirectoryHandle) {
        handle = await parent.getDirectoryHandle(sub);
        const others = await Promise.all(
          sp.groups
            .filter((g) => g.folder !== sub)
            .map((g) => parent.getDirectoryHandle!(g.folder)),
        );
        props.onAnimals?.(others);
      }
    } catch (err) {
      setPickError(`Could not open ${sub}: ${err instanceof Error ? err.message : err}`);
      return;
    }
    const kinds = groupKinds(detectSeries(entries));
    const { chosen, candidates } = chooseKind(kinds);
    const kind = chosen ?? candidates[0];
    props.onProject?.({
      rootName: sub,
      entries,
      handle,
      sessions: kind ? sessionsForKind(entries, kind) : [],
    });
  }

  const openProjectFolder = () => {
    setPickError(null);
    reopenResults = null;
    if (!supportsDirectoryPicker()) {
      projectInput.click();
      return;
    }
    pickDirectoryWithHandle().then(
      (picked) => {
        if (picked) submitProject(picked.entries, picked.handle);
      },
      (err: unknown) => {
        setPickError(`Could not open the folder: ${err instanceof Error ? err.message : err}`);
      },
    );
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
          ref={projectInput}
          type="file"
          class="cala-hidden-input"
          data-testid="project-input"
          // @ts-expect-error webkitdirectory is not in lib.dom's input attributes
          webkitdirectory=""
          multiple
          onChange={(e) => {
            submitProject(entriesFromFiles(Array.from(e.currentTarget.files ?? [])));
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

      <Show when={props.onProject && !props.addMode}>
        <section class="cala-projects-entry" aria-labelledby="projects-entry-title">
          <h2 id="projects-entry-title" class="cala-sessions__title">
            Animal projects
          </h2>
          <p class="file-info">
            <button
              type="button"
              class="btn-primary"
              data-testid="open-project"
              title="An animal folder of sessions: see every session's cala status, run them, and keep the results together"
              onClick={openProjectFolder}
            >
              Open animal project
            </button>
          </p>
          <Show when={(props.recent ?? []).length > 0}>
            <ul class="cala-recent" data-testid="recent-projects">
              <For each={props.recent}>
                {(r) => (
                  <li class="cala-recent__item" data-testid="recent-project">
                    <button
                      type="button"
                      class="btn-secondary btn-small"
                      data-testid="recent-open"
                      onClick={() => void reopen(r)}
                    >
                      {r.name}
                    </button>{' '}
                    <span class="cala-muted">opened {new Date(r.openedAt).toLocaleString()}</span>{' '}
                    <button
                      type="button"
                      class="btn-link btn-small"
                      aria-label={`Forget ${r.name}`}
                      onClick={() => props.onForget?.(r)}
                    >
                      Forget
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </section>
      </Show>

      <Show when={split()}>
        {(sp) => (
          <section class="cala-series-chooser" data-testid="split-chooser" aria-label="Animals">
            <h2 class="cala-series-chooser__title">
              This folder looks like {sp().groups.length} animals. Open one as a project:
            </h2>
            <ul class="cala-series-chooser__list">
              <For each={sp().groups}>
                {(g) => (
                  <li>
                    <button
                      type="button"
                      class="btn-secondary cala-series-chooser__option"
                      data-testid="split-option"
                      onClick={() => void openAnimal(g.folder)}
                    >
                      <strong>{g.folder}</strong> {'\u2014'} {g.sessions.length} sessions
                    </button>
                  </li>
                )}
              </For>
            </ul>
            <p class="cala-muted">
              Each animal becomes its own project with its own <code>cala-results</code> folder
              {supportsDirectoryPicker() ? '; the others are added to Recent projects' : ''}.
            </p>
            <button
              type="button"
              class="btn-secondary btn-small"
              data-testid="split-one"
              onClick={() => void openAnimal(null)}
            >
              No, open it all as one project
            </button>
          </section>
        )}
      </Show>

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
