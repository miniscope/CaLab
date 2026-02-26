import { createSignal, type JSX } from 'solid-js';

type PanelVariant = 'controls' | 'data' | 'interactive' | 'default' | 'flush';

interface DashboardPanelProps {
  id: string;
  variant?: PanelVariant;
  class?: string;
  label?: string;
  collapsible?: boolean;
  defaultCollapsed?: boolean;
  'data-tutorial'?: string;
  children: JSX.Element;
}

export function DashboardPanel(props: DashboardPanelProps): JSX.Element {
  const variant = () => props.variant ?? 'default';
  const [collapsed, setCollapsed] = createSignal(props.defaultCollapsed ?? false);

  return (
    <div
      class={`dashboard-panel dashboard-panel--${variant()}${props.class ? ` ${props.class}` : ''}${props.collapsible && collapsed() ? ' dashboard-panel--collapsed' : ''}`}
      data-panel-id={props.id}
      data-tutorial={props['data-tutorial']}
    >
      {props.collapsible && props.label ? (
        <>
          <button
            class="panel-collapse-header"
            onClick={() => setCollapsed((c) => !c)}
            aria-expanded={!collapsed()}
            aria-controls={`${props.id}-body`}
          >
            <span class="panel-label">{props.label}</span>
            <svg
              class={`panel-collapse-chevron${collapsed() ? '' : ' panel-collapse-chevron--open'}`}
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
            >
              <path
                d="M3 4.5L6 7.5L9 4.5"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
          <div
            id={`${props.id}-body`}
            class={`panel-collapse-body${collapsed() ? ' panel-collapse-body--hidden' : ''}`}
          >
            {props.children}
          </div>
        </>
      ) : (
        props.children
      )}
    </div>
  );
}
