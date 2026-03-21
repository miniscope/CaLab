import { createSignal, type JSX, type ParentProps } from 'solid-js';

const DEFAULT_COL = 1 / 3;
const DEFAULT_ROW = 0.5;
const MIN = 0.15;
const MAX = 0.85;

function clamp(v: number): number {
  return Math.max(MIN, Math.min(MAX, v));
}

export function ResizableGrid(props: ParentProps): JSX.Element {
  let ref: HTMLDivElement | undefined;
  const [col, setCol] = createSignal(DEFAULT_COL);
  const [row, setRow] = createSignal(DEFAULT_ROW);
  const [dragging, setDragging] = createSignal(false);

  function startDrag(axis: 'col' | 'row' | 'both', e: PointerEvent) {
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    setDragging(true);

    const onMove = (me: PointerEvent) => {
      const rect = ref!.getBoundingClientRect();
      if (axis !== 'row') setCol(clamp((me.clientX - rect.left) / rect.width));
      if (axis !== 'col') setRow(clamp((me.clientY - rect.top) / rect.height));
    };

    const cleanup = () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', cleanup);
      el.removeEventListener('lostpointercapture', cleanup);
      setDragging(false);
    };

    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', cleanup);
    el.addEventListener('lostpointercapture', cleanup);
  }

  function reset() {
    setCol(DEFAULT_COL);
    setRow(DEFAULT_ROW);
  }

  return (
    <div
      ref={ref}
      class="viz-grid"
      classList={{ 'viz-grid--dragging': dragging() }}
      style={{
        'grid-template-columns': `${col()}fr ${1 - col()}fr`,
        'grid-template-rows': `${row()}fr ${1 - row()}fr`,
      }}
    >
      {props.children}

      <div
        class="viz-grid__handle viz-grid__handle--col"
        style={{ left: `${col() * 100}%` }}
        onPointerDown={(e) => startDrag('col', e)}
        onDblClick={reset}
      />
      <div
        class="viz-grid__handle viz-grid__handle--row"
        style={{ top: `${row() * 100}%` }}
        onPointerDown={(e) => startDrag('row', e)}
        onDblClick={reset}
      />
      <div
        class="viz-grid__handle viz-grid__handle--both"
        style={{ left: `${col() * 100}%`, top: `${row() * 100}%` }}
        onPointerDown={(e) => startDrag('both', e)}
        onDblClick={reset}
      />
    </div>
  );
}
