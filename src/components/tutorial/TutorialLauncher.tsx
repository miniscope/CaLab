// TutorialLauncher: header button to open/close the tutorial panel.

import type { Accessor, JSX } from 'solid-js';

interface TutorialLauncherProps {
  isOpen: Accessor<boolean>;
  onToggle: () => void;
}

export function TutorialLauncher(props: TutorialLauncherProps): JSX.Element {
  return (
    <button
      class="btn-secondary btn-small"
      data-tutorial="tutorial-launcher"
      onClick={props.onToggle}
    >
      {props.isOpen() ? 'Close Tutorial' : 'Tutorial'}
    </button>
  );
}
