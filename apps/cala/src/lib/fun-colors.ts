/**
 * Display colour schemes of the cell overlay besides the QC modes (`qc-colors.ts`): every cell
 * its own colour by ID (Rainbow, Neon, Candy), and Live activity, where a footprint lights up
 * as its cell fires and then fades (`activity.ts`). Overlay colours only: the image under it,
 * its display range and every result stay as they are. Pure, unit-tested.
 */
import type { Rgb } from './cell-overlay.ts';

export type FunMode = 'rainbow' | 'neon' | 'candy' | 'activity';

export interface FunModeInfo {
  label: string;
  note: string;
  /** A playful scheme the Fun touches switch hides (Live activity is a real view and stays). */
  playful: boolean;
}

export const FUN_MODES: Record<FunMode, FunModeInfo> = {
  activity: {
    label: 'Live activity',
    note: 'lights up as each cell fires during playback, then fades; updates twice a second',
    playful: false,
  },
  rainbow: { label: 'Rainbow by ID', note: 'every cell its own hue', playful: true },
  neon: { label: 'Neon', note: 'glowing outlines', playful: true },
  candy: { label: 'Candy', note: 'soft pastels', playful: true },
};

export const isFunMode = (m: string): m is FunMode => m in FUN_MODES;

/** HSL (h in turns, s and l in 0..1) to RGB bytes. */
export function hsl(h: number, s: number, l: number): Rgb {
  const hh = ((h % 1) + 1) % 1;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + hh * 12) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

/** The golden-angle step: consecutive IDs land far apart on the hue wheel. */
const GOLDEN = 0.381966;

/** Rainbow by ID: bright hues that never repeat in order, light enough for the dark image. */
export const rainbowColor = (id: number): Rgb => hsl(id * GOLDEN, 0.85, 0.62);

/** Neon tubes: five electric colours by ID (drawn with a glow halo). */
export const NEON: readonly Rgb[] = [
  [0x2e, 0xf9, 0xff],
  [0xff, 0x3c, 0xf2],
  [0x9d, 0xff, 0x3a],
  [0xff, 0xe8, 0x3a],
  [0xa8, 0x6b, 0xff],
];
export const neonColor = (id: number): Rgb =>
  NEON[((id % NEON.length) + NEON.length) % NEON.length];

/** Candy: soft pastels by ID (golden-angle hue, low saturation, high lightness). */
export const candyColor = (id: number): Rgb => hsl(0.07 + id * GOLDEN, 0.9, 0.8);

/** Live activity: a quiet cell is a dim blue outline; a firing one runs hot to near-white. */
const QUIET: Rgb = [0x3b, 0x6f, 0xa8];
const WARM: Rgb = [0xff, 0x9f, 0x2e];
const HOT: Rgb = [0xff, 0xf6, 0xc8];

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];

/** Colour of a cell with display glow `g` (0 quiet .. 1 firing). */
export function activityColor(g: number): Rgb {
  const t = Math.min(1, Math.max(0, g));
  return t < 0.6 ? mix(QUIET, WARM, t / 0.6) : mix(WARM, HOT, (t - 0.6) / 0.4);
}

/** Fill opacity of a cell with glow `g`: none when quiet, up to a soft fill when firing. */
export const activityFill = (g: number): number =>
  g < 0.15 ? 0 : 0.45 * Math.min(1, Math.max(0, g));

/** The legend's keys of a scheme (CSS colours). */
export function funKey(mode: FunMode): string[] {
  const css = (c: Rgb) => `rgb(${c[0]},${c[1]},${c[2]})`;
  switch (mode) {
    case 'rainbow':
      return [0, 1, 2, 3, 4].map((i) => css(rainbowColor(i)));
    case 'neon':
      return NEON.map(css);
    case 'candy':
      return [0, 1, 2, 3, 4].map((i) => css(candyColor(i)));
    case 'activity':
      return [0, 0.6, 1].map((g) => css(activityColor(g)));
  }
}
