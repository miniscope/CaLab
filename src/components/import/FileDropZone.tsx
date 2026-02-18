// FileDropZone - Drag-and-drop file import with click fallback
// Accepts .npy and .npz files, parses them, and updates the data store

import { createSignal, Show } from 'solid-js';
import { parseNpy } from '../../lib/npy-parser.ts';
import { parseNpz } from '../../lib/npz-parser.ts';
import {
  rawFile,
  setRawFile,
  setParsedData,
  setNpzArrays,
  setImportError,
  importError,
} from '../../lib/data-store.ts';
import { processNpyResult } from '../../lib/array-utils.ts';

export function FileDropZone() {
  const [isDragging, setIsDragging] = createSignal(false);
  let inputRef: HTMLInputElement | undefined;

  const formatSize = (bytes: number): string => {
    const mb = bytes / (1024 * 1024);
    return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
  };

  const handleFile = async (file: File) => {
    const ext = file.name.split('.').pop()?.toLowerCase();

    if (ext !== 'npy' && ext !== 'npz') {
      setImportError(`Unsupported file format: .${ext ?? 'unknown'}. Please use .npy or .npz files.`);
      return;
    }

    setImportError(null);
    setRawFile(file);

    try {
      const buffer = await file.arrayBuffer();

      if (ext === 'npz') {
        const npzResult = parseNpz(buffer);
        // Filter to only 2D numeric arrays
        const twoDArrayNames = npzResult.arrayNames.filter(name => {
          const arr = npzResult.arrays[name];
          return arr.shape.length === 2;
        });

        if (twoDArrayNames.length === 0) {
          setImportError('No 2D arrays found in .npz file. CaTune requires a 2D array (cells x timepoints).');
          return;
        }

        if (twoDArrayNames.length === 1) {
          // Auto-select the only 2D array
          const processed = processNpyResult(npzResult.arrays[twoDArrayNames[0]]);
          setParsedData(processed);
        } else {
          // Multiple 2D arrays: let user select
          setNpzArrays(npzResult);
        }
      } else {
        // .npy file
        const result = parseNpy(buffer);
        const processed = processNpyResult(result);
        setParsedData(processed);
      }
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Unknown error reading file');
    }
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    const file = e.dataTransfer?.files[0];
    if (file) handleFile(file);
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

  const handleClick = () => inputRef?.click();

  const handleInputChange = (e: Event) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) handleFile(file);
  };

  return (
    <div class="drop-zone-wrapper">
      <div
        class={`drop-zone ${isDragging() ? 'drop-zone--active' : ''}`}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={handleClick}
      >
        <div class="drop-zone__icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
        </div>
        <p class="drop-zone__text">Drop a <strong>.npy</strong> or <strong>.npz</strong> file here</p>
        <p class="drop-zone__subtext">or click to browse</p>
        <input
          ref={inputRef}
          type="file"
          accept=".npy,.npz"
          style="display:none"
          onChange={handleInputChange}
        />
      </div>

      <Show when={rawFile()}>
        <p class="file-info">
          Loaded <strong>{rawFile()!.name}</strong> ({formatSize(rawFile()!.size)})
        </p>
      </Show>

      <Show when={importError()}>
        <div class="error-card">
          <span class="error-card__icon">!</span>
          <span>{importError()}</span>
        </div>
      </Show>
    </div>
  );
}
