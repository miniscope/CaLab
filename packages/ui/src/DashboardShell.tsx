import { createSignal, Show, type JSX } from 'solid-js';

export interface DashboardShellProps {
  header: JSX.Element;
  sidebar?: JSX.Element;
  children: JSX.Element;
  /** Whether the sidebar is open. Defaults to `false`. */
  sidebarOpen?: boolean;
  /** Callback invoked when the user requests toggling the sidebar (also drives the in-sidebar collapse button, shown only when provided). */
  onToggleSidebar?: () => void;
  /**
   * Initial sidebar width as a CSS length (default: the stylesheet's 380px).
   * A `clamp()` keeps it proportional to the window until the user drags it.
   */
  sidebarWidth?: string;
  /** Show a drag handle on the sidebar's left edge (double-click resets). */
  sidebarResizable?: boolean;
}

/** Bounds for a dragged sidebar width, in px. */
export const SIDEBAR_MIN_PX = 320;
export const SIDEBAR_MAX_FRACTION = 0.6;

export function clampSidebarWidth(px: number, viewportWidth: number): number {
  const max = Math.max(SIDEBAR_MIN_PX, viewportWidth * SIDEBAR_MAX_FRACTION);
  return Math.round(Math.max(SIDEBAR_MIN_PX, Math.min(max, px)));
}

export function DashboardShell(props: DashboardShellProps): JSX.Element {
  const isOpen = () => props.sidebarOpen ?? false;
  // User-dragged width in px; null means "use the sidebarWidth default".
  const [dragWidth, setDragWidth] = createSignal<number | null>(null);
  const [resizing, setResizing] = createSignal(false);

  const width = () => {
    const w = dragWidth();
    return w != null ? `${w}px` : props.sidebarWidth;
  };

  function startResize(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture?.(e.pointerId);
    setResizing(true);
    const onMove = (me: PointerEvent) =>
      setDragWidth(clampSidebarWidth(window.innerWidth - me.clientX, window.innerWidth));
    const cleanup = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', cleanup);
      handle.removeEventListener('lostpointercapture', cleanup);
      setResizing(false);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', cleanup);
    handle.addEventListener('lostpointercapture', cleanup);
  }

  return (
    <div
      class="dashboard-shell"
      classList={{
        'dashboard-shell--sidebar-open': isOpen(),
        'dashboard-shell--resizing': resizing(),
      }}
      style={width() ? { '--sidebar-width': width() } : undefined}
    >
      <div class="dashboard-shell__header">{props.header}</div>
      <div class="dashboard-shell__main">{props.children}</div>
      <div class="dashboard-shell__sidebar">
        <Show when={props.sidebarResizable && isOpen()}>
          <div
            class="dashboard-shell__sidebar-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            title="Drag to resize; double-click to reset"
            onPointerDown={startResize}
            onDblClick={() => setDragWidth(null)}
          />
        </Show>
        <Show when={isOpen() && props.onToggleSidebar}>
          <button
            type="button"
            class="dashboard-shell__sidebar-collapse"
            aria-label="Collapse sidebar"
            title="Collapse sidebar (reopen with the Sidebar button in the header)"
            data-testid="sidebar-collapse"
            onClick={() => props.onToggleSidebar?.()}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path
                d="M3 3l5 5-5 5M9 3l5 5-5 5"
                fill="none"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
        </Show>
        <div class="dashboard-shell__sidebar-body">{props.sidebar}</div>
      </div>
    </div>
  );
}
