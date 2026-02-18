/**
 * Sidebar tab switcher: Community | Spectrum | Metrics
 *
 * Uses lazy rendering: a tab's content is only mounted the first time
 * it becomes active. Once mounted, it stays in the DOM (hidden via
 * display:none) to preserve component state and avoid re-initialization.
 *
 * The active tab signal is module-level so other components (e.g. MetricsPanel)
 * can gate expensive computation on tab visibility.
 */

import { createSignal, createEffect, For, Show, type JSX } from 'solid-js';

export type SidebarTab = 'community' | 'spectrum' | 'metrics';

// Module-level signal so MetricsPanel can skip computation when not visible.
const [activeSidebarTab, setActiveSidebarTab] = createSignal<SidebarTab>('community');
export { activeSidebarTab };

// Tracks which tabs have been mounted at least once.
const [mountedTabs, setMountedTabs] = createSignal<Set<string>>(new Set());

export interface SidebarTabsProps {
  communityContent?: JSX.Element;
  metricsContent: JSX.Element;
  spectrumContent?: JSX.Element;
}

export function SidebarTabs(props: SidebarTabsProps) {
  const tabs = (): { id: SidebarTab; label: string; content: JSX.Element }[] => {
    const list: { id: SidebarTab; label: string; content: JSX.Element }[] = [];
    if (props.communityContent) list.push({ id: 'community', label: 'Community', content: props.communityContent });
    if (props.spectrumContent) list.push({ id: 'spectrum', label: 'Spectrum', content: props.spectrumContent });
    list.push({ id: 'metrics', label: 'Metrics', content: props.metricsContent });
    return list;
  };

  const defaultTab: SidebarTab = props.communityContent
    ? 'community'
    : props.spectrumContent
      ? 'spectrum'
      : 'metrics';

  setActiveSidebarTab(defaultTab);
  setMountedTabs(new Set([defaultTab]));

  // When the active tab changes, add it to the mounted set (once mounted, stays mounted)
  createEffect(() => {
    const tab = activeSidebarTab();
    setMountedTabs((prev) => {
      if (prev.has(tab)) return prev;
      const next = new Set(prev);
      next.add(tab);
      return next;
    });
  });

  return (
    <div class="sidebar-tabs">
      <div class="sidebar-tabs__bar">
        <For each={tabs()}>
          {(tab) => (
            <button
              class={`sidebar-tabs__tab${activeSidebarTab() === tab.id ? ' sidebar-tabs__tab--active' : ''}`}
              onClick={() => setActiveSidebarTab(tab.id)}
            >
              {tab.label}
            </button>
          )}
        </For>
      </div>
      <div class="sidebar-tabs__content">
        <For each={tabs()}>
          {(tab) => (
            <Show when={mountedTabs().has(tab.id)}>
              <div style={{ display: activeSidebarTab() === tab.id ? 'block' : 'none' }}>
                {tab.content}
              </div>
            </Show>
          )}
        </For>
      </div>
    </div>
  );
}
