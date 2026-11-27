import type { IconName } from './Icon.tsx';

/** Status tones: reserved for status, always shown with an icon and a label. */
export type StatusTone = 'ok' | 'warning' | 'critical';

/** cala run stages; each has a full hue and a tint token. */
export type StageHue = 'discover' | 'settle' | 'extract';

/**
 * Colour role of a mark: `neutral` (grey), `accent` (the app's selection colour, for the
 * selected or focused thing only), a stage hue, or a status tone.
 */
export type Tone = 'neutral' | 'accent' | StageHue | StatusTone;

/** The icon every status tone carries next to its label. */
export const STATUS_ICON: Record<StatusTone, IconName> = {
  ok: 'check',
  warning: 'warning',
  critical: 'cross',
};

/** True for the reserved status tones. */
export function isStatusTone(t: Tone): t is StatusTone {
  return t === 'ok' || t === 'warning' || t === 'critical';
}

/** CSS colour (a token reference) of a tone's full-strength mark. */
export function toneColor(t: Tone): string {
  switch (t) {
    case 'neutral':
      return 'var(--mark-neutral)';
    case 'accent':
      return 'var(--accent)';
    case 'discover':
    case 'settle':
    case 'extract':
      return `var(--stage-${t})`;
    default:
      return `var(--status-${t})`;
  }
}

/** CSS colour (a token reference) of a tone's pale tint. */
export function toneTint(t: Tone): string {
  switch (t) {
    case 'neutral':
      return 'var(--inset)';
    case 'accent':
      return 'var(--accent-muted)';
    case 'discover':
    case 'settle':
    case 'extract':
      return `var(--stage-${t}-tint)`;
    default:
      return `var(--status-${t}-tint)`;
  }
}
