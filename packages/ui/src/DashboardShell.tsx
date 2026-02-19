import type { JSX } from 'solid-js';

export interface DashboardShellProps {
  header: JSX.Element;
  sidebar?: JSX.Element;
  children: JSX.Element;
  /** Whether the sidebar is open. Defaults to `false`. */
  sidebarOpen?: boolean;
  /** Callback invoked when the user requests toggling the sidebar. */
  onToggleSidebar?: () => void;
}

export function DashboardShell(props: DashboardShellProps): JSX.Element {
  const isOpen = () => props.sidebarOpen ?? false;

  return (
    <div class={`dashboard-shell${isOpen() ? ' dashboard-shell--sidebar-open' : ''}`}>
      <div class="dashboard-shell__header">{props.header}</div>
      <div class="dashboard-shell__main">{props.children}</div>
      <div class="dashboard-shell__sidebar">{props.sidebar}</div>
    </div>
  );
}
