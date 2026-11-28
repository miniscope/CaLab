import { createSignal, type JSX } from 'solid-js';
import { Icon } from './Icon.tsx';
import { SegmentedControl, type SegmentedOption } from './SegmentedControl.tsx';
import { applyThemeChoice, readThemeChoice, saveThemeChoice, type ThemeChoice } from './theme.ts';

export interface ThemeToggleProps {
  testid?: string;
}

/** Built per toggle: JSX nodes cannot be shared between two mounted toggles. */
const options = (): SegmentedOption<ThemeChoice>[] => [
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
];

/**
 * Three-way theme choice (system, light, dark) for a page header. Applies the choice to the
 * root element and stores it (`theme.ts`); the page's boot script applies the stored choice
 * before first paint.
 */
export function ThemeToggle(props: ThemeToggleProps): JSX.Element {
  const [choice, setChoice] = createSignal<ThemeChoice>(readThemeChoice());
  const pick = (c: ThemeChoice) => {
    setChoice(c);
    applyThemeChoice(c);
    saveThemeChoice(c);
  };
  return (
    <SegmentedControl
      options={options()}
      value={choice()}
      onChange={pick}
      aria-label="Colour theme"
      size="sm"
      class="theme-toggle"
      testid={props.testid ?? 'theme-toggle'}
    />
  );
}
