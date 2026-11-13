import { createSignal, For, Show, type JSX } from 'solid-js';
import { ImportFeedbackLinks } from '@calab/community-ui';
import { filesFromDrop } from '../lib/dropped-files.ts';
import { entriesFromFiles, type FolderEntry } from '../lib/frame-source.ts';
import {
  chooseSeries,
  detectSeries,
  entriesForSeries,
  seriesLabel,
  type VideoSeries,
} from '../lib/video-series.ts';
import { pickDirectory, supportsDirectoryPicker } from '../lib/directory-picker.ts';

interface OpenFolderProps {
  loading: boolean;
  error: string | null;
  /** Called with every file picked or dropped, and a label for the header. */
  onOpen: (entries: FolderEntry[], label: string) => void;
  /** Connect to a live source (a WebSocket URL, see `lib/live-source.ts`). */
  onOpenLive?: (url: string) => void;
  /** The URL offered in the live-source field. */
  liveUrl?: string;
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
    series: VideoSeries<FolderEntry>[];
    candidates: VideoSeries<FolderEntry>[];
  } | null>(null);
  let chooserHeading: HTMLHeadingElement | undefined;

  const submit = (entries: FolderEntry[]) => {
    if (entries.length === 0) return;
    const series = detectSeries(entries);
    const { chosen, candidates } = chooseSeries(series);
    if (chosen || candidates.length === 0) {
      setPending(null);
      props.onOpen(entries, labelFor(entries));
      return;
    }
    setPending({ entries, series, candidates });
    queueMicrotask(() => chooserHeading?.focus());
  };

  const choose = (picked: VideoSeries<FolderEntry>) => {
    const p = pending();
    if (!p) return;
    setPending(null);
    props.onOpen(entriesForSeries(p.entries, p.series, picked), labelFor(p.entries));
  };

  // Chrome and Edge: the read-only directory picker ("view files"). Elsewhere
  // the hidden webkitdirectory input, whose prompt says "upload".
  const openFolder = () => {
    setPickError(null);
    if (!supportsDirectoryPicker()) {
      folderInput.click();
      return;
    }
    pickDirectory().then(
      // eslint-disable-next-line solid/reactivity -- a one-off promise callback, not a tracked scope
      (entries) => {
        if (entries) submit(entries);
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
            <strong>Open a Miniscope folder</strong> or drop it here
          </p>
          <p class="drop-zone__subtext">
            The folder with the numbered videos (0.avi, 1.avi, ... or msCam0.avi, msCam1.avi, ...)
            and metaData.json, timeStamps.csv. Videos are read frame by frame from disk, never
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
                      <strong>{seriesLabel(s)}</strong> {'\u2014'} {s.files.length}{' '}
                      {s.files.length === 1 ? 'file' : 'files'}
                      <span class="cala-series-chooser__dir">
                        {s.dir === '' ? '(selected files)' : s.dir}
                      </span>
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
