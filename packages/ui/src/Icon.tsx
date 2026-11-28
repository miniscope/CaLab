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
  /** Theme choices: follow the system (a display), light (a sun), dark (a moon). */
  system: ['M2 3h12v8H2z', 'M6 14h4', 'M8 11v3'],
  sun: [
    'M8 5a3 3 0 1 0 0 6a3 3 0 1 0 0-6z',
    'M8 1.5v1.5',
    'M8 13v1.5',
    'M1.5 8h1.5',
    'M13 8h1.5',
    'M3.4 3.4l1 1',
    'M11.6 11.6l1 1',
    'M3.4 12.6l1-1',
    'M11.6 4.4l1-1',
  ],
  moon: ['M13 9.5A5.5 5.5 0 1 1 6.5 3a4.5 4.5 0 0 0 6.5 6.5z'],
  /** Unlockable themes: synthwave (a sun setting on a ruled horizon), lab notebook (a pen nib). */
  wave: ['M3 9a5 5 0 0 1 10 0', 'M1.5 9h13', 'M3 11.5h10', 'M5 14h6'],
  pen: ['M10.5 2.5l3 3-7.5 7.5-3.75.75.75-3.75z', 'M9 4l3 3', 'M3 13l1.5-1.5'],
  /** Fun touches: a four-point sparkle. */
  sparkle: [
    'M8 1.5c.6 3.4 1.6 4.4 5 5c-3.4.6-4.4 1.6-5 5c-.6-3.4-1.6-4.4-5-5c3.4-.6 4.4-1.6 5-5z',
    'M13 11.5v3',
    'M11.5 13h3',
  ],
  /** A music note (the choir). */
  note: [
    'M6 12.5a1.75 1.75 0 1 1-3.5 0a1.75 1.75 0 1 1 3.5 0z',
    'M6 12.5V3l7-1.5v9',
    'M13 10.5a1.75 1.75 0 1 1-3.5 0a1.75 1.75 0 1 1 3.5 0z',
  ],
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
