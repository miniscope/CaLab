import { createSignal, onCleanup, type JSX } from 'solid-js';
import { Icon } from './Icon.tsx';
import { SegmentedControl, type SegmentedOption } from './SegmentedControl.tsx';
import {
  applyThemeChoice,
  onThemeChange,
  readThemeChoice,
  saveThemeChoice,
  type Theme,
  type ThemeChoice,
} from './theme.ts';

export interface ThemeToggleProps {
  testid?: string;
  /** Hidden themes to offer as well (e.g. ones the user unlocked), after system, light, dark. */
  extra?: readonly Theme[];
}

const EXTRA: Partial<Record<Theme, { icon: 'wave' | 'pen'; title: string }>> = {
  synthwave: { icon: 'wave', title: 'Theme: synthwave' },
  notebook: { icon: 'pen', title: 'Theme: lab notebook' },
};

/** Built per toggle: JSX nodes cannot be shared between two mounted toggles. */
const options = (extra: readonly Theme[] = []): SegmentedOption<ThemeChoice>[] => [
  {
    value: 'system',
    label: <Icon name="system" size={14} label="System" />,
    title: 'Theme: follow the system',
    testid: 'theme-system',
  },
  {
    value: 'light',
    label: <Icon name="sun" size={14} label="Light" />,
    title: 'Theme: light',
    testid: 'theme-light',
  },
  {
    value: 'dark',
    label: <Icon name="moon" size={14} label="Dark" />,
    title: 'Theme: dark',
    testid: 'theme-dark',
  },
  ...extra.flatMap((t) => {
    const e = EXTRA[t];
    return e
      ? [
          {
            value: t,
            label: <Icon name={e.icon} size={14} label={e.title.replace('Theme: ', '')} />,
            title: e.title,
            testid: `theme-${t}`,
          },
        ]
      : [];
  }),
];

/**
 * Three-way theme choice (system, light, dark) for a page header. Applies the choice to the
 * root element and stores it (`theme.ts`); the page's boot script applies the stored choice
 * before first paint.
 */
export function ThemeToggle(props: ThemeToggleProps): JSX.Element {
  const [choice, setChoice] = createSignal<ThemeChoice>(readThemeChoice());
  // A theme applied elsewhere (another toggle, an app's shortcut) shows here too.
  onCleanup(onThemeChange(() => setChoice(readThemeChoice())));
  const pick = (c: ThemeChoice) => {
    setChoice(c);
    applyThemeChoice(c);
    saveThemeChoice(c);
  };
  return (
    <SegmentedControl
      options={options(props.extra)}
      value={choice()}
      onChange={pick}
      aria-label="Colour theme"
      size="sm"
      class="theme-toggle"
      testid={props.testid ?? 'theme-toggle'}
    />
  );
}
