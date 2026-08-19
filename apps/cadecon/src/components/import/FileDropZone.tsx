import { createSignal, Show, type JSX } from 'solid-js';
import { parseNpy, parseNpz, parseMat, processNpyResult } from '@calab/io';
import type { NpzResult } from '@calab/core';
import {
  rawFile,
  setRawFile,
  setParsedData,
  setNpzArrays,
  setImportError,
  setDataSource,
  importError,
} from '../../lib/data-store.ts';
import { soleTraceCandidate, traceCandidates } from '../../lib/trace-candidates.ts';

export function FileDropZone(): JSX.Element {
  const [isDragging, setIsDragging] = createSignal(false);
  let inputRef: HTMLInputElement | undefined;

  const formatSize = (bytes: number): string => {
    const mb = bytes / (1024 * 1024);
    return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
  };

  // Shared handling for multi-array containers (.npz and .mat): load the traces
  // directly when the choice is unambiguous, or hand off to the array selector.
  const handleMultiArrayResult = (result: NpzResult, ext: string) => {
    if (traceCandidates(result).length === 0) {
      setImportError(
        `No trace matrix found in .${ext} file. CaDecon requires a 2D array (cells x timepoints).`,
      );
      return;
    }

    const sole = soleTraceCandidate(result);
    if (sole !== null) {
      setParsedData(processNpyResult(result.arrays[sole]));
    } else {
      setNpzArrays(result);
    }
  };

  const handleFile = async (file: File) => {
    const ext = file.name.split('.').pop()?.toLowerCase();

    if (ext !== 'npy' && ext !== 'npz' && ext !== 'mat') {
      setImportError(
        `Unsupported file format: .${ext ?? 'unknown'}. Please use .npy, .npz, or .mat files.`,
      );
      return;
    }

    setImportError(null);
    setRawFile(file);
    setDataSource('file');

    try {
      const buffer = await file.arrayBuffer();

      if (ext === 'npz') {
        handleMultiArrayResult(parseNpz(buffer), 'npz');
      } else if (ext === 'mat') {
        handleMultiArrayResult(parseMat(buffer), 'mat');
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
    if (file) void handleFile(file);
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
    if (file) void handleFile(file);
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
