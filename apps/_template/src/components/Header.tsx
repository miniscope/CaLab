import type { JSX } from 'solid-js';
import { CompactHeader } from '@calab/ui';
import { CommunityAuthMenu, FeedbackMenu } from '@calab/community-ui';

interface HeaderProps {
  dataLabel: string;
  numCells: number;
  numTimepoints: number;
  samplingRate: number;
  onChangeData: () => void;
}

export function Header(props: HeaderProps): JSX.Element {
  return (
    <CompactHeader
      title="__APP_DISPLAY_NAME__"
      version={`CaLab ${import.meta.env.VITE_APP_VERSION || 'dev'}`}
      info={
        <>
          <span class="compact-header__file">{props.dataLabel}</span>
          <span class="compact-header__sep">&middot;</span>
          <span>{props.numCells} cells</span>
          <span class="compact-header__sep">&middot;</span>
          <span>{props.numTimepoints.toLocaleString()} tp</span>
          <span class="compact-header__sep">&middot;</span>
          <span>{props.samplingRate} Hz</span>
        </>
      }
      actions={
        <>
          <button class="btn-secondary btn-small" onClick={() => props.onChangeData()}>
            Change Data
          </button>
          <FeedbackMenu appId={__APP_ID__} />
          <CommunityAuthMenu />
        </>
      }
    />
  );
}
