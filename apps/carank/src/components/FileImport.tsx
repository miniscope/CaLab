import { type JSX, createSignal } from 'solid-js';
import { parseNpy } from '@catune/io';
import type { CnmfData } from '../types.ts';

interface FileImportProps {
  onImport: (data: CnmfData) => void;
}

export function FileImport(props: FileImportProps): JSX.Element {
  const [dragging, setDragging] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let fileInputRef!: HTMLInputElement;

  const processFile = async (file: File) => {
    setError(null);
    try {
      const buffer = await file.arrayBuffer();
      const result = parseNpy(buffer);

      if (result.shape.length !== 2) {
        setError(`Expected 2D array (cells x timepoints), got ${result.shape.length}D`);
        return;
      }

      const data: Float64Array =
        result.data instanceof Float64Array ? result.data : new Float64Array(result.data);

      props.onImport({
        traces: data,
        numCells: result.shape[0],
        numTimepoints: result.shape[1],
        fileName: file.name,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to parse file');
    }
  };

  const handleDrop: JSX.EventHandler<HTMLDivElement, DragEvent> = (e) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer?.files[0];
    if (file) processFile(file);
  };

  const handleDragOver: JSX.EventHandler<HTMLDivElement, DragEvent> = (e) => {
    e.preventDefault();
    setDragging(true);
  };

  const handleDragLeave = () => setDragging(false);

  const handleClick = () => {
    fileInputRef.click();
  };

  return (
    <div class="import-container">
      <div class="app-header">
        <h1 class="app-header__title">CaRank</h1>
        <p class="app-header__subtitle">Quality ranking for CNMF calcium traces</p>
      </div>

      <div
        class={`drop-zone${dragging() ? ' drop-zone--active' : ''}`}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={handleClick}
      >
        <div class="drop-zone__icon">&#8595;</div>
        <p class="drop-zone__text">Drop a .npy file here</p>
        <p class="drop-zone__subtext">2D array: cells &times; timepoints</p>
      </div>

      {error() && (
        <div class="error-card">
          <span class="error-card__icon">!</span>
          <span>{error()}</span>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept=".npy"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          if (file) processFile(file);
        }}
      />
    </div>
  );
}
