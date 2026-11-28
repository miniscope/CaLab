import {
  createEffect,
  createSignal,
  createUniqueId,
  For,
  onCleanup,
  Show,
  type JSX,
} from 'solid-js';

export interface TabStripItem {
  id: string;
  label: JSX.Element;
  testid?: string;
  title?: string;
  /** Folded under the strip's "More" menu instead of shown in the row. */
  more?: boolean;
}

export interface TabStripProps {
  tabs: TabStripItem[];
  active: string | null;
  onSelect: (id: string) => void;
  /** Default 'underline'. */
  variant?: 'underline' | 'caps';
  class?: string;
  trailing?: JSX.Element;
  'aria-label'?: string;
  /**
   * Prefix of the element ids: tab `<idBase>-tab-<id>` controls panel
   * `<idBase>-panel-<id>` (`Tabs` renders the panels with those ids).
   */
  idBase?: string;
  /** Test id of the More button (tabs with `more`); its menu gets `<moreTestid>-menu`. */
  moreTestid?: string;
}

/** Element id of a tab button (`idBase` given). */
export const tabId = (base: string, id: string) => `${base}-tab-${id}`;
/** Element id of a tab panel (`idBase` given). */
export const tabPanelId = (base: string, id: string) => `${base}-panel-${id}`;
/** Element id of the More button (`idBase` given). */
export const tabMoreId = (base: string) => `${base}-more`;

/** Row position of the More button in keyboard navigation. */
const MORE: unique symbol = Symbol('more');

/**
 * Row of tab buttons (no panels). Use `Tabs` when the panels live with the strip.
 * Keyboard: one tab stop (the active tab); Left/Right move to the previous or
 * next tab and select it, Home/End to the first or last.
 *
 * Tabs with `more` sit in a menu behind a "More ▾" button at the row's end (a tab
 * itself, selected while one of them is active, and then labelled with it).
 * Arrow keys reach the button without opening it; Down, Enter or Space opens the
 * menu, whose items move with Up/Down and pick with Enter; Escape or a click
 * outside closes it.
 */
export function TabStrip(p: TabStripProps): JSX.Element {
  const top = () => p.tabs.filter((t) => !t.more);
  const folded = () => p.tabs.filter((t) => t.more);
  const activeFolded = () => folded().find((t) => t.id === p.active);
  /** The row as the arrow keys walk it: the shown tabs, then the More button. */
  const row = (): (string | typeof MORE)[] => {
    const r: (string | typeof MORE)[] = top().map((t) => t.id);
    if (folded().length > 0) r.push(MORE);
    return r;
  };
  const [open, setOpen] = createSignal(false);
  let moreWrap: HTMLDivElement | undefined;
  let moreBtn: HTMLButtonElement | undefined;
  let menu: HTMLDivElement | undefined;

  const menuItems = () =>
    menu ? Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')) : [];
  const openMenu = () => {
    setOpen(true);
    queueMicrotask(() => {
      const items = menuItems();
      (items.find((el) => el.getAttribute('aria-checked') === 'true') ?? items[0])?.focus();
    });
  };
  const closeMenu = (focusButton: boolean) => {
    setOpen(false);
    if (focusButton) moreBtn?.focus();
  };
  // A click outside the More button and its menu closes the menu.
  createEffect(() => {
    if (!open()) return;
    const onDown = (e: PointerEvent) => {
      if (moreWrap && !moreWrap.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    onCleanup(() => document.removeEventListener('pointerdown', onDown));
  });

  const onMenuKeyDown = (e: KeyboardEvent) => {
    const items = menuItems();
    const at = items.indexOf(document.activeElement as HTMLElement);
    let next: number;
    if (e.key === 'ArrowDown') next = (at + 1) % items.length;
    else if (e.key === 'ArrowUp') next = (Math.max(at, 0) - 1 + items.length) % items.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    else if (e.key === 'Escape') {
      e.preventDefault();
      closeMenu(true);
      return;
    } else if (e.key === 'Tab') {
      closeMenu(false);
      return;
    } else return;
    e.preventDefault();
    items[next]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (menu?.contains(e.target as Node)) {
      e.stopPropagation();
      onMenuKeyDown(e);
      return;
    }
    if (e.target === moreBtn && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      openMenu();
      return;
    }
    const r = row();
    const n = r.length;
    if (n === 0) return;
    const at = r.indexOf(activeFolded() ? MORE : (p.active ?? ''));
    const focusedMore = e.target === moreBtn;
    const from = focusedMore ? r.indexOf(MORE) : at;
    let next: number;
    if (e.key === 'ArrowRight') next = (from + 1 + n) % n;
    else if (e.key === 'ArrowLeft') next = (Math.max(from, 0) - 1 + n) % n;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    else return;
    e.preventDefault();
    const strip = e.currentTarget as HTMLElement;
    const target = r[next];
    if (target !== MORE) p.onSelect(target);
    // Focus follows the selection once it has re-rendered.
    queueMicrotask(() => strip.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus());
  };
  /** The tab in the tab order: the active one (More for a folded one), else the first. */
  const stop = () =>
    activeFolded() ? MORE : top().some((t) => t.id === p.active) ? p.active : top()[0]?.id;
  const moreId = () => (p.idBase ? tabMoreId(p.idBase) : undefined);
  return (
    <div
      class={`tab-strip tab-strip--${p.variant ?? 'underline'}${p.class ? ' ' + p.class : ''}`}
      classList={{ 'tab-strip--has-more': folded().length > 0 }}
      role="tablist"
      aria-label={p['aria-label']}
      onKeyDown={onKeyDown}
    >
      <For each={top()}>
        {(tab) => (
          <button
            type="button"
            role="tab"
            id={p.idBase ? tabId(p.idBase, tab.id) : undefined}
            aria-controls={p.idBase ? tabPanelId(p.idBase, tab.id) : undefined}
            aria-selected={p.active === tab.id}
            tabIndex={stop() === tab.id ? 0 : -1}
            class="tab-strip__tab"
            classList={{ 'tab-strip__tab--active': p.active === tab.id }}
            data-testid={tab.testid}
            title={tab.title}
            onClick={() => p.onSelect(tab.id)}
          >
            {tab.label}
          </button>
        )}
      </For>
      <Show when={folded().length > 0}>
        <div class="tab-strip__more" role="presentation" ref={moreWrap}>
          <button
            ref={moreBtn}
            type="button"
            role="tab"
            id={moreId()}
            aria-haspopup="menu"
            aria-expanded={open()}
            aria-controls={
              p.idBase && activeFolded() ? tabPanelId(p.idBase, activeFolded()!.id) : undefined
            }
            aria-selected={activeFolded() !== undefined}
            tabIndex={stop() === MORE ? 0 : -1}
            class="tab-strip__tab tab-strip__more-button"
            classList={{ 'tab-strip__tab--active': activeFolded() !== undefined }}
            data-testid={p.moreTestid}
            title={activeFolded()?.title ?? 'More panels'}
            onClick={() => (open() ? closeMenu(false) : openMenu())}
          >
            {activeFolded()?.label ?? 'More'}
            <span class="tab-strip__caret" aria-hidden="true">
              ▾
            </span>
          </button>
          <Show when={open()}>
            <div
              ref={menu}
              class="tab-strip__menu"
              role="menu"
              aria-labelledby={moreId()}
              data-testid={p.moreTestid ? `${p.moreTestid}-menu` : undefined}
            >
              <For each={folded()}>
                {(tab) => (
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={p.active === tab.id}
                    tabIndex={-1}
                    class="tab-strip__menu-item"
                    data-testid={tab.testid}
                    title={tab.title}
                    onClick={() => {
                      p.onSelect(tab.id);
                      closeMenu(true);
                    }}
                  >
                    {tab.label}
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>
      <Show when={p.trailing}>
        <span class="tab-strip__trailing">{p.trailing}</span>
      </Show>
    </div>
  );
}

export interface TabItem extends TabStripItem {
  content: JSX.Element | (() => JSX.Element);
  /** Overrides `TabsProps.keepMounted` for this tab. */
  keepMounted?: boolean;
}

export interface TabsProps {
  tabs: TabItem[];
  /** Controlled selection when given. */
  active?: string;
  /** Initial tab when uncontrolled (default: the first tab). */
  defaultTab?: string;
  onChange?: (id: string) => void;
  variant?: 'underline' | 'caps';
  /** Class on the wrapper. */
  class?: string;
  barClass?: string;
  panelClass?: string;
  /** Display of the active panel (default 'block'). */
  panelDisplay?: 'block' | 'contents' | 'flex';
  /**
   * Mount every panel and hide inactive ones (default true); false mounts only
   * the active one. A tab's own `keepMounted` wins.
   */
  keepMounted?: boolean;
  trailing?: JSX.Element;
  'aria-label'?: string;
  /** Prefix of the tab and panel ids (default: a unique one). */
  idBase?: string;
  /** Test id of the More button (tabs with `more`); see `TabStripProps.moreTestid`. */
  moreTestid?: string;
}

/** Tab strip plus its panels. Panel content given as a function is resolved once per mount. */
export function Tabs(p: TabsProps): JSX.Element {
  const [internal, setInternal] = createSignal<string | undefined>(p.defaultTab);
  const active = () => p.active ?? internal() ?? p.tabs[0]?.id ?? null;
  const select = (id: string) => {
    if (p.active === undefined) setInternal(id);
    p.onChange?.(id);
  };
  // eslint-disable-next-line solid/reactivity -- the ids are fixed per mount
  const base = p.idBase ?? createUniqueId();
  const resolve = (c: TabItem['content']) => (typeof c === 'function' ? c() : c);
  return (
    <div class={`tabs${p.class ? ' ' + p.class : ''}`}>
      <TabStrip
        tabs={p.tabs}
        active={active()}
        onSelect={select}
        variant={p.variant}
        class={p.barClass}
        trailing={p.trailing}
        aria-label={p['aria-label']}
        idBase={base}
        moreTestid={p.moreTestid}
      />
      <For each={p.tabs}>
        {(tab) => {
          const isActive = () => active() === tab.id;
          const label = typeof tab.label === 'string' ? tab.label : undefined;
          const panel = (display: () => string) => (
            <div
              role="tabpanel"
              id={tabPanelId(base, tab.id)}
              aria-labelledby={
                label !== undefined ? undefined : tab.more ? tabMoreId(base) : tabId(base, tab.id)
              }
              aria-label={label}
              class={p.panelClass}
              data-tab={tab.id}
              style={{ display: display() }}
            >
              {resolve(tab.content)}
            </div>
          );
          return (tab.keepMounted ?? p.keepMounted ?? true) ? (
            panel(() => (isActive() ? (p.panelDisplay ?? 'block') : 'none'))
          ) : (
            <Show when={isActive()}>{panel(() => p.panelDisplay ?? 'block')}</Show>
          );
        }}
      </For>
    </div>
  );
}
