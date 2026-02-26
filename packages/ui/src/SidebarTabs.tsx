/**
 * Generic sidebar tab switcher with lazy rendering.
 *
 * A tab's content is only mounted the first time it becomes active.
 * Once mounted, it stays in the DOM (hidden via display:none) to preserve
 * component state and avoid re-initialization.
 */

import { createSignal, createEffect, For, Show, type JSX } from 'solid-js';
import './styles/community.css';

export interface SidebarTabConfig {
  id: string;
  label: string;
  content: JSX.Element;
  onActivate?: () => void;
}

export interface SidebarTabsProps {
  tabs: SidebarTabConfig[];
  defaultTab?: string;
}

export function SidebarTabs(props: SidebarTabsProps) {
  const defaultId = () => props.defaultTab ?? props.tabs[0]?.id ?? '';
  const [activeTab, setActiveTab] = createSignal(defaultId());
  const [mountedTabs, setMountedTabs] = createSignal<Set<string>>(new Set([defaultId()]));

  // When the active tab changes, add it to the mounted set
  createEffect(() => {
    const tab = activeTab();
    setMountedTabs((prev) => {
      if (prev.has(tab)) return prev;
      const next = new Set(prev);
      next.add(tab);
      return next;
    });
  });

  function handleTabClick(tab: SidebarTabConfig) {
    setActiveTab(tab.id);
    tab.onActivate?.();
  }

  return (
    <div class="sidebar-tabs">
      <div class="sidebar-tabs__bar">
        <For each={props.tabs}>
          {(tab) => (
            <button
              class={`sidebar-tabs__tab${activeTab() === tab.id ? ' sidebar-tabs__tab--active' : ''}`}
              data-tutorial={`sidebar-tab-${tab.id}`}
              onClick={() => handleTabClick(tab)}
            >
              {tab.label}
            </button>
          )}
        </For>
      </div>
      <div class="sidebar-tabs__content">
        <For each={props.tabs}>
          {(tab) => (
            <Show when={mountedTabs().has(tab.id)}>
              <div style={{ display: activeTab() === tab.id ? 'block' : 'none' }}>
                {tab.content}
              </div>
            </Show>
          )}
        </For>
      </div>
    </div>
  );
}
