import { createSignal, createUniqueId, For, Show, type JSX } from 'solid-js';

export interface TabStripItem {
  id: string;
  label: JSX.Element;
  testid?: string;
  title?: string;
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
}

/** Element id of a tab button (`idBase` given). */
export const tabId = (base: string, id: string) => `${base}-tab-${id}`;
/** Element id of a tab panel (`idBase` given). */
export const tabPanelId = (base: string, id: string) => `${base}-panel-${id}`;

/**
 * Row of tab buttons (no panels). Use `Tabs` when the panels live with the strip.
 * Keyboard: one tab stop (the active tab); Left/Right move to the previous or
 * next tab and select it, Home/End to the first or last.
 */
export function TabStrip(p: TabStripProps): JSX.Element {
  const onKeyDown = (e: KeyboardEvent) => {
    const n = p.tabs.length;
    if (n === 0) return;
    const at = p.tabs.findIndex((t) => t.id === p.active);
    let next: number;
    if (e.key === 'ArrowRight') next = (at + 1 + n) % n;
    else if (e.key === 'ArrowLeft') next = (Math.max(at, 0) - 1 + n) % n;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    else return;
    e.preventDefault();
    const strip = e.currentTarget as HTMLElement;
    p.onSelect(p.tabs[next].id);
    // Focus follows the selection once it has re-rendered.
    queueMicrotask(() => strip.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus());
  };
  /** The tab in the tab order: the active one, else the first. */
  const stop = () => (p.tabs.some((t) => t.id === p.active) ? p.active : p.tabs[0]?.id);
  return (
    <div
      class={`tab-strip tab-strip--${p.variant ?? 'underline'}${p.class ? ' ' + p.class : ''}`}
      role="tablist"
      aria-label={p['aria-label']}
      onKeyDown={onKeyDown}
    >
      <For each={p.tabs}>
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
      />
      <For each={p.tabs}>
        {(tab) => {
          const isActive = () => active() === tab.id;
          const label = typeof tab.label === 'string' ? tab.label : undefined;
          const panel = (display: () => string) => (
            <div
              role="tabpanel"
              id={tabPanelId(base, tab.id)}
              aria-labelledby={label === undefined ? tabId(base, tab.id) : undefined}
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
