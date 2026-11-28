import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import {
  THEME_STORAGE_KEY,
  applyThemeChoice,
  onThemeChange,
  readThemeChoice,
  resolveCssColor,
  saveThemeChoice,
} from '../theme.ts';
import { ThemeToggle } from '../ThemeToggle.tsx';

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.style.removeProperty('--probe');
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('theme choice', () => {
  it('stores, reads and applies a pinned theme; system removes the attribute', () => {
    expect(readThemeChoice()).toBe('system');
    saveThemeChoice('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(readThemeChoice()).toBe('dark');
    applyThemeChoice('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    saveThemeChoice('system');
    applyThemeChoice('system');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('reads an invalid stored value, or blocked storage, as system', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'neon');
    expect(readThemeChoice()).toBe('system');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readThemeChoice()).toBe('system');
    expect(() => saveThemeChoice('light')).not.toThrow();
  });

  it('notifies on a data-theme change', async () => {
    const cb = vi.fn();
    const off = onThemeChange(cb);
    applyThemeChoice('dark');
    await Promise.resolve();
    expect(cb).toHaveBeenCalled();
    off();
  });

  it('resolves var() references for canvas and passes other colours through', () => {
    document.documentElement.style.setProperty('--probe', '#123456');
    const el = document.documentElement;
    expect(resolveCssColor(el, 'var(--probe)')).toBe('#123456');
    expect(resolveCssColor(el, 'var(--missing, #abcdef)')).toBe('#abcdef');
    expect(resolveCssColor(el, 'var(--missing)', '#000001')).toBe('#000001');
    expect(resolveCssColor(el, '#0072b2')).toBe('#0072b2');
  });
});

describe('ThemeToggle', () => {
  it('shows the stored choice and applies and stores a new one', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    const host = document.createElement('div');
    document.body.appendChild(host);
    dispose = render(() => <ThemeToggle />, host);
    const checked = () =>
      host.querySelector('[aria-checked="true"]')?.getAttribute('data-testid') ?? null;
    expect(checked()).toBe('theme-light');
    host.querySelector<HTMLButtonElement>('[data-testid="theme-dark"]')!.click();
    expect(checked()).toBe('theme-dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });
});
