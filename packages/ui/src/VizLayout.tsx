import { type JSX, onMount, onCleanup } from 'solid-js';

interface VizLayoutProps {
  mode?: 'scroll' | 'dashboard';
  sidebar?: JSX.Element;
  sidebarWidth?: string;
  children: JSX.Element;
}

export function VizLayout(props: VizLayoutProps): JSX.Element {
  const mode = () => props.mode ?? 'dashboard';

  onMount(() => {
    if (mode() === 'dashboard') {
      document.documentElement.classList.add('dashboard-mode');
    }
  });

  onCleanup(() => {
    document.documentElement.classList.remove('dashboard-mode');
  });

  return (
    <div
      class={`viz-layout viz-layout--${mode()}`}
      style={props.sidebar ? { '--sidebar-width': props.sidebarWidth ?? '260px' } : undefined}
    >
      {mode() === 'dashboard' && props.sidebar ? (
        <>
          <div class="viz-layout__sidebar">{props.sidebar}</div>
          <div class="viz-layout__content">{props.children}</div>
        </>
      ) : (
        props.children
      )}
    </div>
  );
}
