/**
 * The header's theme and fun controls: the theme toggle (with any hidden theme the user
 * unlocked), the Fun touches switch, and, while the choir sings, its Stop button. Mounting it
 * also installs the page's Easter-egg listeners once (`installEasterEggs`).
 */
import { createEffect, createRoot, Show, type JSX } from 'solid-js';
import {
  applyThemeChoice,
  Icon,
  readThemeChoice,
  saveThemeChoice,
  THEMES,
  ThemeToggle,
  type Theme,
} from '@calab/ui';
import { pageChoir } from '../lib/choir.ts';
import {
  createClickCounter,
  createSequenceDetector,
  delight,
  HIDDEN_THEMES,
  isTypingTarget,
} from '../lib/delight.ts';
import { soul } from '../lib/soul.ts';

/** The app's name in any header: seven quick clicks on it unlock the hidden themes. */
const MARK = '.compact-header__title, .app-header__title';

const isHidden = (t: string): boolean => (HIDDEN_THEMES as readonly string[]).includes(t);

/** Pin a theme now and for the next visit. */
function pinTheme(t: Theme | 'system'): void {
  saveThemeChoice(t);
  applyThemeChoice(t);
}

let installed = false;

/**
 * The page's Easter eggs, installed once (window listeners; nothing per frame):
 * - the Konami code starts the cell choir (again: stops it); Escape stops it;
 * - seven quick clicks on the Cala name unlock the hidden themes and step through them.
 * Keys typed into fields never count, and nothing calls preventDefault.
 */
export function installEasterEggs(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const fun = delight();
  const konami = createSequenceDetector();
  const clicks = createClickCounter(7, 600);

  window.addEventListener('keydown', (e) => {
    if (isTypingTarget(e.target)) return;
    if (e.key === 'Escape' && fun.choir()) {
      fun.setChoir(false);
      return;
    }
    if (!konami(e.key) || !fun.on()) return;
    if (fun.choir()) fun.setChoir(false);
    // Inside the key handler: the browser lets audio start on this gesture.
    else if (pageChoir().start()) fun.setChoir(true);
  });

  document.addEventListener('click', (e) => {
    const t = e.target as Element | null;
    const mark = t?.closest?.(MARK) as HTMLElement | null;
    if (!mark || !clicks(performance.now()) || !fun.on()) return;
    fun.unlock(HIDDEN_THEMES);
    const now = readThemeChoice();
    const at = HIDDEN_THEMES.indexOf(now as (typeof HIDDEN_THEMES)[number]);
    pinTheme(HIDDEN_THEMES[(at + 1) % HIDDEN_THEMES.length]);
    mark.classList.remove('cala-mark--found');
    void mark.offsetWidth;
    mark.classList.add('cala-mark--found');
    setTimeout(() => mark.classList.remove('cala-mark--found'), 900);
  });

  // The switch off: a hidden theme goes back to following the system; the choir stops.
  fun.onOff(() => {
    if (isHidden(readThemeChoice())) pinTheme('system');
  });
  createRoot(() => {
    createEffect(() => {
      if (!fun.choir()) pageChoir().stop();
    });
    // The heartbeat: while a stage runs, the dot after the name beats with the cells' onsets
    // (one beat per 2 Hz tick that had any, its size the share of cells that fired). Quiet ticks
    // and idle: still. Transform and opacity only, on the compositor.
    const life = soul();
    createEffect(() => {
      const b = life.beat();
      if (b.strength <= 0 || !fun.motion()) return;
      if (!document.documentElement.hasAttribute('data-cala-run')) return;
      for (const el of document.querySelectorAll<HTMLElement>(MARK)) {
        if (typeof el.animate !== 'function') continue;
        const k = 1.35 + 1.25 * b.strength;
        el.animate(
          [
            { transform: 'scale(1)', opacity: 0.9, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' },
            { transform: `scale(${k})`, opacity: 1, offset: 0.12, easing: 'ease-out' },
            { transform: 'scale(1)', opacity: 0.9 },
          ],
          { duration: 420 + 260 * b.strength, pseudoElement: '::after' },
        );
      }
    });
  });
}

/** Header controls (see the module comment). Used in place of a bare `ThemeToggle`. */
export function ThemeMenu(): JSX.Element {
  installEasterEggs();
  const fun = delight();
  const extra = (): Theme[] =>
    fun.on() ? (THEMES as readonly Theme[]).filter((t) => fun.unlocked().includes(t)) : [];
  return (
    <span class="cala-theme-menu">
      <Show when={fun.choir()}>
        <button
          type="button"
          class="btn-secondary btn-small cala-choir-stop"
          data-testid="choir-stop"
          title="The cells are singing: each note is a cell firing, panned by where it sits left to right, pitched by its height. Stop (or press Escape)."
          onClick={() => fun.setChoir(false)}
        >
          <Icon name="note" size={14} />
          Stop choir
        </button>
      </Show>
      <ThemeToggle extra={extra()} />
      <button
        type="button"
        class="btn-secondary btn-small cala-icon-btn cala-fun-toggle"
        aria-pressed={fun.on()}
        aria-label="Fun touches"
        title={
          fun.on()
            ? 'Fun touches are on: small moments at milestones and stage ends, playful colour schemes, and a few surprises. Click to turn them all off.'
            : 'Fun touches are off. Click to turn them back on.'
        }
        data-testid="fun-toggle"
        onClick={() => fun.setOn(!fun.on())}
      >
        <Icon name="sparkle" size={14} />
      </button>
    </span>
  );
}
