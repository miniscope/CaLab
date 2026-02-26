/** Cell selector dropdown with prev/next arrows. */

import type { JSX } from 'solid-js';

export interface CellSelectorProps {
  cellIndices: () => number[];
  selectedIndex: () => number | null;
  onSelect: (idx: number) => void;
}

export function CellSelector(props: CellSelectorProps): JSX.Element {
  const currentPos = () => {
    const sel = props.selectedIndex();
    if (sel == null) return -1;
    return props.cellIndices().indexOf(sel);
  };

  const canPrev = () => currentPos() > 0;
  const canNext = () => {
    const pos = currentPos();
    return pos >= 0 && pos < props.cellIndices().length - 1;
  };

  const goPrev = () => {
    const pos = currentPos();
    if (pos > 0) props.onSelect(props.cellIndices()[pos - 1]);
  };

  const goNext = () => {
    const pos = currentPos();
    const indices = props.cellIndices();
    if (pos >= 0 && pos < indices.length - 1) props.onSelect(indices[pos + 1]);
  };

  return (
    <div class="cell-selector">
      <button class="cell-selector__arrow" disabled={!canPrev()} onClick={goPrev}>
        &#x25C0;
      </button>
      <select
        class="cell-selector__select"
        value={String(props.selectedIndex() ?? '')}
        onChange={(e) => {
          const v = parseInt(e.currentTarget.value, 10);
          if (!isNaN(v)) props.onSelect(v);
        }}
      >
        {props.cellIndices().map((idx) => (
          <option value={String(idx)}>Cell {idx}</option>
        ))}
      </select>
      <button class="cell-selector__arrow" disabled={!canNext()} onClick={goNext}>
        &#x25B6;
      </button>
    </div>
  );
}
