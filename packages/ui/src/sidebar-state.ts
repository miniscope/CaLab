/**
 * Open/close + active-tab state for the DashboardShell's right sidebar, with a
 * one-shot "reveal" used to surface a tab (e.g. the dataset overview) when new
 * data arrives. Once the user closes the sidebar, reveals are ignored for the
 * rest of the session so it never pops back open against their choice.
 */

import { createSignal, type Accessor } from 'solid-js';

export interface DashboardSidebarState {
  open: Accessor<boolean>;
  tab: Accessor<string>;
  setTab: (id: string) => void;
  /** Header "Sidebar" button: flips open/closed; closing counts as a dismissal. */
  toggle: () => void;
  /** Open on `tabId` unless the user has closed the sidebar this session. Returns whether it opened. */
  reveal: (tabId: string) => boolean;
  /** True once the user has closed the sidebar. */
  dismissed: Accessor<boolean>;
}

export function createDashboardSidebar(initialTab: string): DashboardSidebarState {
  const [open, setOpen] = createSignal(false);
  const [tab, setTab] = createSignal(initialTab);
  const [dismissed, setDismissed] = createSignal(false);

  const toggle = () => {
    if (open()) setDismissed(true);
    setOpen(!open());
  };

  const reveal = (tabId: string) => {
    if (dismissed()) return false;
    setTab(tabId);
    setOpen(true);
    return true;
  };

  return { open, tab, setTab, toggle, reveal, dismissed };
}
