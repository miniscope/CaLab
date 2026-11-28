/**
 * Colour theme: which token set of `styles/tokens.css` the page uses, and how canvas code
 * follows it.
 *
 * A theme is a `data-theme` value on the root element. No attribute means "system": the light
 * tokens, or the dark ones when the OS prefers dark. `data-theme="light"` and `"dark"` pin a
 * set. A further theme is one more `:root[data-theme='<name>']` block in `tokens.css`, one
 * more entry in `THEMES` and its name in the boot script of the pages that restore a choice
 * before first paint (`apps/cala/index.html`).
 *
 * Canvas cannot read CSS variables, so canvas code resolves its colours with `resolveCssColor`
 * and redraws on `onThemeChange`.
 */
import { createSignal, onCleanup, type Accessor } from 'solid-js';

/** Themes a page can pin, besides following the system. */
export const THEMES = ['light', 'dark'] as const;
/** A pinned theme (a `data-theme` value with a token set in `tokens.css`). */
export type Theme = (typeof THEMES)[number];
/** The user's choice: follow the OS, or pin a theme. */
export type ThemeChoice = 'system' | Theme;

/** localStorage key of the choice (shared by the apps of one origin that offer a toggle). */
export const THEME_STORAGE_KEY = 'calab-theme';

const isChoice = (v: unknown): v is ThemeChoice =>
  v === 'system' || (THEMES as readonly unknown[]).includes(v);

/** The stored choice; 'system' when nothing valid is stored or storage is unavailable. */
export function readThemeChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    return isChoice(v) ? v : 'system';
  } catch {
    return 'system';
  }
}

/** Store the choice; a storage failure only loses the choice for the next visit. */
export function saveThemeChoice(choice: ThemeChoice): void {
  try {
    if (choice === 'system') localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    /* storage blocked: the choice holds for this page only */
  }
}

/** Put the choice on `root`: a pinned theme sets `data-theme`, 'system' removes it. */
export function applyThemeChoice(
  choice: ThemeChoice,
  root: HTMLElement = document.documentElement,
): void {
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
}

/**
 * Call `cb` whenever the resolved theme can have changed: the root's `data-theme` (or class)
 * changes, or the OS colour preference flips. Returns the unsubscribe function.
 */
export function onThemeChange(cb: () => void): () => void {
  if (typeof document === 'undefined') return () => {};
  const mq =
    typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : undefined;
  mq?.addEventListener?.('change', cb);
  const mo = typeof MutationObserver !== 'undefined' ? new MutationObserver(cb) : undefined;
  mo?.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'class'],
  });
  return () => {
    mo?.disconnect();
    mq?.removeEventListener?.('change', cb);
  };
}

const VAR_REF = /^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/;

/**
 * A colour usable on a canvas: `var(--name)` or `var(--name, fallback)` resolves to the
 * custom property's computed value on `el` (or the fallback, or `fallback`); any other string
 * is returned unchanged.
 */
export function resolveCssColor(el: Element, color: string, fallback = '#888888'): string {
  const m = VAR_REF.exec(color.trim());
  if (!m) return color;
  const v = getComputedStyle(el).getPropertyValue(m[1]).trim();
  return v || m[2]?.trim() || fallback;
}

/**
 * A Solid accessor that changes on every theme change (`onThemeChange`), for effects that draw
 * with theme colours: read it inside the effect and the effect reruns on a theme change. Call
 * inside a component or root (it registers its cleanup there).
 */
export function createThemeVersion(): Accessor<number> {
  const [version, setVersion] = createSignal(0);
  onCleanup(onThemeChange(() => setVersion((n) => n + 1)));
  return version;
}
