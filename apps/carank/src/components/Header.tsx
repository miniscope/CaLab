import type { JSX } from 'solid-js';
import { CompactHeader } from '@catune/ui';

interface HeaderProps {
  fileName: string;
  numCells: number;
  numTimepoints: number;
  onChangeData: () => void;
}

export function Header(props: HeaderProps): JSX.Element {
  const version = () => `CaLab ${import.meta.env.VITE_APP_VERSION || 'dev'}`;

  return (
    <CompactHeader
      title="CaRank"
      version={version()}
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
        <button class="btn-secondary btn-small" onClick={props.onChangeData}>
          Change Data
        </button>
      }
    />
  );
}
