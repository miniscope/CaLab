import { createSignal, For, Show, type JSX } from 'solid-js';

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
}

/** Row of tab buttons (no panels). Use `Tabs` when the panels live with the strip. */
export function TabStrip(p: TabStripProps): JSX.Element {
  return (
    <div
      class={`tab-strip tab-strip--${p.variant ?? 'underline'}${p.class ? ' ' + p.class : ''}`}
      role="tablist"
      aria-label={p['aria-label']}
    >
      <For each={p.tabs}>
        {(tab) => (
          <button
            type="button"
            role="tab"
            aria-selected={p.active === tab.id}
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
  panelDisplay?: 'block' | 'contents';
  /** Mount every panel and hide inactive ones (default true); false mounts only the active one. */
  keepMounted?: boolean;
  trailing?: JSX.Element;
  'aria-label'?: string;
}

/** Tab strip plus its panels. Panel content given as a function is resolved once. */
export function Tabs(p: TabsProps): JSX.Element {
  const [internal, setInternal] = createSignal<string | undefined>(p.defaultTab);
  const active = () => p.active ?? internal() ?? p.tabs[0]?.id ?? null;
  const select = (id: string) => {
    if (p.active === undefined) setInternal(id);
    p.onChange?.(id);
  };
  const keep = () => p.keepMounted ?? true;
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
      />
      <For each={p.tabs}>
        {(tab) => {
          const isActive = () => active() === tab.id;
          const label = typeof tab.label === 'string' ? tab.label : undefined;
          return keep() ? (
            <div
              role="tabpanel"
              aria-label={label}
              class={p.panelClass}
              style={{ display: isActive() ? (p.panelDisplay ?? 'block') : 'none' }}
            >
              {resolve(tab.content)}
            </div>
          ) : (
            <Show when={isActive()}>
              <div
                role="tabpanel"
                aria-label={label}
                class={p.panelClass}
                style={{ display: p.panelDisplay ?? 'block' }}
              >
                {resolve(tab.content)}
              </div>
            </Show>
          );
        }}
      </For>
    </div>
  );
}
