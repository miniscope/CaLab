import { createSignal, type JSX, type ParentComponent } from 'solid-js';

export interface DashboardShellProps {
  header: JSX.Element;
  sidebar?: JSX.Element;
  children: JSX.Element;
}

// Sidebar state — exported so CompactHeader can toggle it
const [sidebarOpen, setSidebarOpen] = createSignal(false);
export { sidebarOpen, setSidebarOpen };

export const DashboardShell: ParentComponent<DashboardShellProps> = (props) => {
  return (
    <div class={`dashboard-shell${sidebarOpen() ? ' dashboard-shell--sidebar-open' : ''}`}>
      <div class="dashboard-shell__header">
        {props.header}
      </div>
      <div class="dashboard-shell__main">
        {props.children}
      </div>
      <div class="dashboard-shell__sidebar">
        {props.sidebar}
      </div>
    </div>
  );
};
