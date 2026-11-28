import { createMemo, For, type JSX } from 'solid-js';
import { pct } from './range.ts';

/** One part of a segmented bar. */
export interface SegmentPart {
  id: string;
  label: string;
  /** Amount, >= 0; zero or non-finite draws nothing. */
  value: number;
  /** Fill colour (a token reference such as `var(--stage-discover)`). */
  color: string;
  /** Diagonal hatching as a second channel besides the colour. */
  hatched?: boolean;
}

export interface SegmentedBarProps {
  parts: SegmentPart[];
  /** The declared whole the parts are a share of (a fixed total, never the data's sum). */
  total: number;
  /** Accessible name of the whole bar. */
  label: string;
  /** Formats amounts in the accessible text and tooltips (default String). */
  format?: (v: number) => string;
  /** The part a caller's filter has picked: every other part is drawn faded. */
  active?: string;
  /**
   * Called with a part's id when the pointer clicks it. A shortcut for pointer users only: the
   * bar stays an image to assistive tech, so the caller also offers the same choice as buttons.
   */
  onPartClick?: (id: string) => void;
  class?: string;
  testid?: string;
}

/**
 * One whole split into parts: an 8 px bar whose part widths are value / total, in order,
 * with a 2 px surface gap. The remainder of `total` stays empty track. When the parts sum
 * past `total` they are cut at the end and the bar sets `data-clamped="over"`.
 */
export function SegmentedBar(p: SegmentedBarProps): JSX.Element {
  const layout = createMemo(() => {
    if (!(p.total > 0) || !Number.isFinite(p.total)) {
      throw new RangeError(`a segmented bar needs a finite total > 0, got ${p.total}`);
    }
    let used = 0;
    let over = false;
    const out: { part: SegmentPart; width: number }[] = [];
    for (const part of p.parts) {
      if (!(part.value > 0) || !Number.isFinite(part.value)) continue;
      const share = part.value / p.total;
      const room = Math.max(0, 1 - used);
      if (share > room) over = true;
      const width = Math.min(share, room);
      used += share;
      if (width > 0) out.push({ part, width });
    }
    return { out, over };
  });
  const fmt = (v: number) => (p.format ?? String)(v);
  const name = () =>
    `${p.label}: ` +
    p.parts.map((x) => `${x.label} ${fmt(Number.isFinite(x.value) ? x.value : 0)}`).join(', ') +
    ` of ${fmt(p.total)}`;
  return (
    <div
      class={`segmented-bar${p.class ? ' ' + p.class : ''}`}
      role="img"
      aria-label={name()}
      data-clamped={layout().over ? 'over' : undefined}
      data-testid={p.testid}
    >
      <For each={layout().out}>
        {(s) => (
          <span
            class="segmented-bar__part"
            classList={{
              'segmented-bar__part--hatched': !!s.part.hatched,
              'segmented-bar__part--faded': p.active !== undefined && p.active !== s.part.id,
              'segmented-bar__part--clickable': !!p.onPartClick,
            }}
            onClick={() => p.onPartClick?.(s.part.id)}
            style={{ width: pct(s.width), 'background-color': s.part.color }}
            title={`${s.part.label}: ${fmt(s.part.value)}`}
            data-part={s.part.id}
          />
        )}
      </For>
    </div>
  );
}
