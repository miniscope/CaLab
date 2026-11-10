import { createSignal, Show, type JSX } from 'solid-js';
import { ImportFeedbackLinks } from '@calab/community-ui';
import { filesFromDrop } from '../lib/dropped-files.ts';
import { entriesFromFiles, type FolderEntry } from '../lib/frame-source.ts';

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

/** Where the simulator (`scripts/live-sim.mjs`) listens by default. */
export const DEFAULT_LIVE_URL = 'ws://localhost:8765';

/** The folder name for the header: the picked directory, else the first file's name. */
function labelFor(entries: FolderEntry[]): string {
  const rel = entries[0].relPath;
  if (rel.includes('/')) return rel.split('/')[0];
  return entries.length === 1 ? entries[0].file.name : `${entries.length} files`;
}

/** First screen: pick or drop a Miniscope recording folder. */
export function OpenFolder(props: OpenFolderProps): JSX.Element {
  const [dragging, setDragging] = createSignal(false);
  // The offered URL seeds the field once; the user edits it from there.
  // eslint-disable-next-line solid/reactivity
  const [liveUrl, setLiveUrl] = createSignal(props.liveUrl ?? DEFAULT_LIVE_URL);
  let folderInput!: HTMLInputElement;
  let filesInput!: HTMLInputElement;

  const submit = (entries: FolderEntry[]) => {
    if (entries.length > 0) props.onOpen(entries, labelFor(entries));
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
          onClick={() => folderInput.click()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              folderInput.click();
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
            The folder with 0.avi, 1.avi, ... (and metaData.json, timeStamps.csv). Videos are read
            frame by frame from disk, never loaded whole, and never uploaded.
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
            Or stream from a live source{' '}
            <input
              type="text"
              class="cala-live-open__url"
              data-testid="live-url"
              value={liveUrl()}
              onInput={(e) => setLiveUrl(e.currentTarget.value)}
              placeholder={DEFAULT_LIVE_URL}
              spellcheck={false}
            />
          </label>{' '}
          <button type="submit" class="btn-secondary btn-small" data-testid="live-connect">
            Connect
          </button>
        </form>
      </Show>

      <Show when={props.loading}>
        <p class="file-info" role="status">
          Opening...
        </p>
      </Show>
      <Show when={props.error}>
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
