import { type ParentComponent, type JSX, onMount, onCleanup } from 'solid-js';

interface VizLayoutProps {
  mode?: 'scroll' | 'dashboard';
  children: JSX.Element;
}

export const VizLayout: ParentComponent<VizLayoutProps> = (props) => {
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
};
