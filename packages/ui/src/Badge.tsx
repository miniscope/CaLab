import { Show, type JSX } from 'solid-js';
import { Icon, type IconName } from './Icon.tsx';
import { isStatusTone, STATUS_ICON, type Tone } from './tones.ts';

export interface BadgeProps {
  /** Visible label (required: colour never carries the meaning alone). */
  children: JSX.Element;
  /** Colour role (default neutral). Status tones always show their icon. */
  tone?: Tone;
  /** Icon before the label; status tones default to their status icon. */
  icon?: IconName;
  title?: string;
  class?: string;
  testid?: string;
}

/**
 * An 18 px pale-tint chip with an ink label. Status tones (ok, warning, critical) use the
 * status ink on its tint and always carry their icon; stage and neutral tones use the text
 * ink with a dot of the hue, since a stage hue on its tint is too faint for text.
 */
export function Badge(p: BadgeProps): JSX.Element {
  const tone = () => p.tone ?? 'neutral';
  const icon = (): IconName | undefined => {
    const t = tone();
    return isStatusTone(t) ? (p.icon ?? STATUS_ICON[t]) : p.icon;
  };
  const dot = () => !icon() && tone() !== 'neutral';
  return (
    <span
      class={`badge badge--${tone()}${p.class ? ' ' + p.class : ''}`}
      title={p.title}
      data-testid={p.testid}
    >
      <Show when={icon()}>{(n) => <Icon name={n()} size={12} />}</Show>
      <Show when={dot()}>
        <span class="badge__dot" aria-hidden="true" />
      </Show>
      <span class="badge__label">{p.children}</span>
    </span>
  );
}
