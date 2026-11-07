import { createSignal, Show, type JSX } from 'solid-js';
import { ImportFeedbackLinks } from '@calab/community-ui';
import { filesFromDrop } from '../lib/dropped-files.ts';

interface OpenFolderProps {
  loading: boolean;
  error: string | null;
  /** Called with every file picked or dropped, and a label for the header. */
  onOpen: (files: File[], label: string) => void;
}

/** The folder name for the header: the picked directory, else the first file's name. */
function labelFor(files: File[]): string {
  const rel = (files[0] as (File & { webkitRelativePath?: string }) | undefined)
    ?.webkitRelativePath;
  if (rel && rel.includes('/')) return rel.split('/')[0];
  return files.length === 1 ? files[0].name : `${files.length} files`;
}

/** First screen: pick or drop a Miniscope recording folder. */
export function OpenFolder(props: OpenFolderProps): JSX.Element {
  const [dragging, setDragging] = createSignal(false);
  let folderInput!: HTMLInputElement;
  let filesInput!: HTMLInputElement;

  const submit = (files: File[]) => {
    if (files.length > 0) props.onOpen(files, labelFor(files));
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
            submit(Array.from(e.currentTarget.files ?? []));
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
            submit(Array.from(e.currentTarget.files ?? []));
            e.currentTarget.value = '';
          }}
        />
      </div>

      <p class="file-info">
        <button type="button" class="btn-secondary btn-small" onClick={() => filesInput.click()}>
          Choose individual files
        </button>
      </p>

      <Show when={props.loading}>
        <p class="file-info" role="status">
          Reading video headers...
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
