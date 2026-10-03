// Drag-and-drop file import with click fallback. Parsing lives in the import
// store (`importFile` in @calab/io); this component is only the drop target.

import { createSignal, Show, type JSX } from 'solid-js';
import type { ImportStore } from '@calab/io';

export interface FileDropZoneProps {
  store: ImportStore;
}

const formatSize = (bytes: number): string => {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
};

export function FileDropZone(props: FileDropZoneProps): JSX.Element {
  const [isDragging, setIsDragging] = createSignal(false);
  let inputRef: HTMLInputElement | undefined;

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    const file = e.dataTransfer?.files[0];
    if (file) void props.store.importFile(file);
  };

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleInputChange = (e: Event) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) void props.store.importFile(file);
  };

  return (
    <div class="drop-zone-wrapper">
      <div
        class={`drop-zone ${isDragging() ? 'drop-zone--active' : ''}`}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={() => inputRef?.click()}
      >
        <div class="drop-zone__icon">
          <svg
            width="48"
            height="48"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
        </div>
        <p class="drop-zone__text">
          Drop a <strong>.npy</strong>, <strong>.npz</strong>, or <strong>.mat</strong> file here
        </p>
        <p class="drop-zone__subtext">or click to browse</p>
        <input
          ref={inputRef}
          type="file"
          accept=".npy,.npz,.mat"
          style="display:none"
          onChange={handleInputChange}
        />
      </div>

      <Show when={props.store.rawFile()}>
        {(file) => (
          <p class="file-info">
            Loaded <strong>{file().name}</strong> ({formatSize(file().size)})
          </p>
        )}
      </Show>

      <Show when={props.store.importError()}>
        <div class="error-card">
          <span class="error-card__icon">!</span>
          <span>{props.store.importError()}</span>
        </div>
      </Show>
    </div>
  );
}
