import { type JSX, onMount, onCleanup } from 'solid-js';

interface VizLayoutProps {
  mode?: 'scroll' | 'dashboard';
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
    <div class={`viz-layout viz-layout--${mode()}`}>
      {props.children}
    </div>
  );
}
