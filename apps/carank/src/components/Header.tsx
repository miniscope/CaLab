import type { Accessor, JSX } from 'solid-js';
import { CompactHeader, TutorialLauncher } from '@calab/ui';
import { AuthMenuWrapper } from './AuthMenuWrapper.tsx';

interface HeaderProps {
  fileName: string;
  numCells: number;
  numTimepoints: number;
  onChangeData: () => void;
  tutorialOpen: Accessor<boolean>;
  onTutorialToggle: () => void;
}

export function Header(props: HeaderProps): JSX.Element {
  const version = `CaLab ${import.meta.env.VITE_APP_VERSION || 'dev'}`;

  return (
    <CompactHeader
      title="CaRank"
      version={version}
      info={
        <>
          <span class="compact-header__file">{props.fileName}</span>
          <span class="compact-header__sep">&middot;</span>
          <span>{props.numCells} cells</span>
          <span class="compact-header__sep">&middot;</span>
          <span>{props.numTimepoints.toLocaleString()} tp</span>
        </>
      }
      actions={
        <>
          <TutorialLauncher isOpen={props.tutorialOpen} onToggle={props.onTutorialToggle} />
          <button class="btn-secondary btn-small" onClick={props.onChangeData}>
            Change Data
          </button>
          <AuthMenuWrapper />
        </>
      }
    />
  );
}
