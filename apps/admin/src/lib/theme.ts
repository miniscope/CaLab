import { createSignal } from 'solid-js';

export type Theme = 'auto' | 'light' | 'dark';

function read(): Theme {
  try {
    const v = localStorage.getItem('calab_admin_theme');
    return v === 'light' || v === 'dark' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

const [theme, setThemeSignal] = createSignal<Theme>(read());

function apply(t: Theme): void {
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}

export function initTheme(): void {
  apply(theme());
}

export function cycleTheme(): void {
  const next: Theme = theme() === 'auto' ? 'light' : theme() === 'light' ? 'dark' : 'auto';
  setThemeSignal(next);
  apply(next);
  try {
    localStorage.setItem('calab_admin_theme', next);
  } catch {
    // Storage blocked: the choice lasts for this page only.
  }
}

export { theme };
