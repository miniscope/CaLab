import { For, type JSX } from 'solid-js';

/** Outline glyphs of the shared icon set, on a 16 x 16 grid, stroked in currentColor. */
const PATHS = {
  play: ['M5 3.5v9l7-4.5z'],
  pause: ['M5.5 3.5v9', 'M10.5 3.5v9'],
  stop: ['M4 4h8v8H4z'],
  restart: ['M3.5 8a4.5 4.5 0 1 0 1.3-3.2', 'M3.5 2.5v2.8h2.8'],
  /** Fit to the data: four corner brackets (e.g. re-fit a display range). */
  fit: ['M2.5 5.5v-3h3', 'M10.5 2.5h3v3', 'M13.5 10.5v3h-3', 'M5.5 13.5h-3v-3'],
  check: ['M3.5 8.5l3 3 6-7'],
  cross: ['M4.5 4.5l7 7', 'M11.5 4.5l-7 7'],
  info: ['M8 1.75a6.25 6.25 0 1 0 0 12.5a6.25 6.25 0 1 0 0-12.5z', 'M8 7.25v4', 'M8 4.75v.5'],
  warning: ['M8 2.25l6.25 11H1.75z', 'M8 6.5v3.25', 'M8 11.5v.25'],
  gpu: [
    'M3.5 3.5h9v9h-9z',
    'M6 6h4v4H6z',
    'M6 1.5v2',
    'M10 1.5v2',
    'M6 12.5v2',
    'M10 12.5v2',
    'M1.5 6h2',
    'M1.5 10h2',
    'M12.5 6h2',
    'M12.5 10h2',
  ],
} as const satisfies Record<string, readonly string[]>;

/** Name of a glyph in the shared icon set. */
export type IconName = keyof typeof PATHS;

/** Every glyph name, in a stable order. */
export const ICON_NAMES = Object.keys(PATHS) as IconName[];

export interface IconProps {
  name: IconName;
  /** Rendered size in px (default 16; the set is drawn for 14 to 16). */
  size?: number;
  /** Accessible name. Without it the icon is decorative (aria-hidden) and a visible label must carry the meaning. */
  label?: string;
  class?: string;
}

/** A 16 x 16 outline icon that takes the current text colour. */
export function Icon(p: IconProps): JSX.Element {
  return (
    <svg
      class={`icon icon--${p.name}${p.class ? ' ' + p.class : ''}`}
      width={p.size ?? 16}
      height={p.size ?? 16}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      role={p.label ? 'img' : undefined}
      aria-label={p.label}
      aria-hidden={p.label ? undefined : 'true'}
    >
      <For each={PATHS[p.name] as readonly string[]}>{(d) => <path d={d} />}</For>
    </svg>
  );
}
