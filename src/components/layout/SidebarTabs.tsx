/**
 * Sidebar tab switcher: Community | Metrics
 * Preserves component state by rendering both, hiding the inactive one.
 */

import { createSignal, type JSX } from 'solid-js';

export type SidebarTab = 'community' | 'metrics';

export interface SidebarTabsProps {
  communityContent: JSX.Element;
  metricsContent: JSX.Element;
}

export function SidebarTabs(props: SidebarTabsProps) {
  const [activeTab, setActiveTab] = createSignal<SidebarTab>('community');

  return (
    <div class="sidebar-tabs">
      <div class="sidebar-tabs__bar">
        <button
          class={`sidebar-tabs__tab${activeTab() === 'community' ? ' sidebar-tabs__tab--active' : ''}`}
          onClick={() => setActiveTab('community')}
        >
          Community
        </button>
        <button
          class={`sidebar-tabs__tab${activeTab() === 'metrics' ? ' sidebar-tabs__tab--active' : ''}`}
          onClick={() => setActiveTab('metrics')}
        >
          Metrics
        </button>
      </div>
      <div class="sidebar-tabs__content">
        <div style={{ display: activeTab() === 'community' ? 'block' : 'none' }}>
          {props.communityContent}
        </div>
        <div style={{ display: activeTab() === 'metrics' ? 'block' : 'none' }}>
          {props.metricsContent}
        </div>
      </div>
    </div>
  );
}
