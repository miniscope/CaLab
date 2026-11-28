import { createSignal, onCleanup, Show, createEffect, type JSX } from 'solid-js';

export interface HelpTipProps {
  /** Accessible name of the "?" button (what it explains, e.g. "About the worker squares"). */
  label: string;
  /** The explanation. */
  children: JSX.Element;
  /** Controlled open state (default: the tip keeps its own). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Extra class of the popover (placement is the caller's: see below). */
  popClass?: string;
  /** Tooltip of the button. */
  title?: string;
  testid?: string;
}

/**
 * A "?" button that opens an explanation. The popover is absolutely positioned against the
 * nearest positioned ancestor, so the caller decides where it sits (`popClass`). Escape and a
 * press outside close it.
 */
export function HelpTip(p: HelpTipProps): JSX.Element {
  const [own, setOwn] = createSignal(false);
  const open = () => p.open ?? own();
  const set = (v: boolean) => {
    setOwn(v);
    p.onOpenChange?.(v);
  };
  let btn: HTMLButtonElement | undefined;
  let pop: HTMLDivElement | undefined;
  const outside = (e: PointerEvent) => {
    const t = e.target as Node | null;
    if (t && (btn?.contains(t) || pop?.contains(t))) return;
    set(false);
  };
  createEffect(() => {
    if (typeof document === 'undefined') return;
    if (open()) document.addEventListener('pointerdown', outside);
    else document.removeEventListener('pointerdown', outside);
  });
  onCleanup(() => {
    if (typeof document !== 'undefined') document.removeEventListener('pointerdown', outside);
  });
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && open()) {
      set(false);
      e.stopPropagation();
      btn?.focus();
    }
  };
  return (
    <>
      <button
        ref={btn}
        type="button"
        class="help-tip"
        aria-label={p.label}
        aria-expanded={open()}
        title={p.title ?? p.label}
        data-testid={p.testid}
        onClick={() => set(!open())}
        onKeyDown={onKey}
      >
        ?
      </button>
      <Show when={open()}>
        <div
          ref={pop}
          class={`help-tip__pop${p.popClass ? ' ' + p.popClass : ''}`}
          role="dialog"
          aria-label={p.label}
          onKeyDown={onKey}
        >
          {p.children}
        </div>
      </Show>
    </>
  );
}
