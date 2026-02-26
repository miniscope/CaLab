/**
 * CaTune SidebarTabs — wraps the shared SidebarTabs component.
 * Preserves the module-level activeSidebarTab signal for MetricsPanel gating.
 */

import { createSignal, type JSX } from 'solid-js';
import { SidebarTabs as SharedSidebarTabs } from '@calab/ui';
import type { SidebarTabConfig } from '@calab/ui';
import { trackEvent } from '@calab/community';

export type SidebarTab = 'community' | 'spectrum' | 'metrics';

// Module-level signal so MetricsPanel can skip computation when not visible.
const [activeSidebarTab, setActiveSidebarTab] = createSignal<SidebarTab>('community');
export { activeSidebarTab };

export interface SidebarTabsProps {
  communityContent?: JSX.Element | (() => JSX.Element);
  metricsContent: JSX.Element;
  spectrumContent?: JSX.Element;
}

export function SidebarTabs(props: SidebarTabsProps) {
  const tabs = (): SidebarTabConfig[] => {
    const list: SidebarTabConfig[] = [];
    if (props.communityContent)
      list.push({
        id: 'community',
        label: 'Community',
        content: props.communityContent,
        onActivate: () => {
          setActiveSidebarTab('community');
          void trackEvent('community_browser_opened');
        },
      });
    if (props.spectrumContent)
      list.push({
        id: 'spectrum',
        label: 'Spectrum',
        content: props.spectrumContent,
        onActivate: () => setActiveSidebarTab('spectrum'),
      });
    list.push({
      id: 'metrics',
      label: 'Metrics',
      content: props.metricsContent,
      onActivate: () => setActiveSidebarTab('metrics'),
    });
    return list;
  };

  let defaultTab: SidebarTab = 'metrics';
  if (props.communityContent) {
    defaultTab = 'community';
  } else if (props.spectrumContent) {
    defaultTab = 'spectrum';
  }

  setActiveSidebarTab(defaultTab);

  return <SharedSidebarTabs tabs={tabs()} defaultTab={defaultTab} />;
}
