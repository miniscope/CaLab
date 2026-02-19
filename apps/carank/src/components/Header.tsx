import type { JSX } from 'solid-js';

interface HeaderProps {
  fileName: string;
  numCells: number;
  numTimepoints: number;
  onChangeData: () => void;
}

export function Header(props: HeaderProps): JSX.Element {
  return (
    <header class="compact-header">
      <div class="compact-header__brand">
        <span class="compact-header__title">CaRank</span>
        <span class="compact-header__version">
          CaLab {import.meta.env.VITE_APP_VERSION || 'dev'}
        </span>
      </div>

      <div class="compact-header__info">
        <span class="compact-header__file">{props.fileName}</span>
        <span class="compact-header__sep">&middot;</span>
        <span>{props.numCells} cells</span>
        <span class="compact-header__sep">&middot;</span>
        <span>{props.numTimepoints.toLocaleString()} tp</span>
      </div>

      <div class="compact-header__actions">
        <button class="btn-secondary btn-small" onClick={props.onChangeData}>
          Change Data
        </button>
      </div>
    </header>
  );
}
