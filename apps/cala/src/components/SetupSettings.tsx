/**
 * The setup page's settings (`ProjectView`): what every run started from this page reads when
 * its Discover starts. Config files, the params' main fields and an Advanced section rendered
 * from the schema, the Speed control, and the slots for further pre-run choices. The Run button
 * is the page's own (one session: Run; several: the plan's).
 */
import { type JSX } from 'solid-js';
import type { CellStore } from '../lib/cell-store.ts';
import type { PipelineStore } from '../lib/pipeline-store.ts';
import { ConfigBar, RunSettingsFields, SheetSlot, type ProjectParams } from './RunSettings.tsx';
import { SpeedControl } from './SpeedControl.tsx';

export interface SetupSettingsProps {
  pipeline: PipelineStore;
  cells: CellStore;
  /** Saving the values into the open project (absent: none can be saved). */
  projectParams?: ProjectParams;
  /** Width of the sessions' frames, px (0: unknown or not the same in all); the optics' binning may follow it. */
  frameWidth: number;
  /** Frame rate of the sessions, Hz (0: unknown or not the same in all). */
  fps: number;
  /** The project is a live stream. */
  live?: boolean;
  /** How many sessions the project has (the wording only). */
  sessions: number;
}

export function SetupSettings(props: SetupSettingsProps): JSX.Element {
  return (
    <section
      class="cala-sessions__card cala-project__card cala-sheet"
      aria-labelledby="setup-settings-title"
      data-testid="setup-settings"
    >
      <h2 id="setup-settings-title" class="cala-sessions__title">
        Settings
      </h2>
      <p class="cala-sheet__lede">
        {props.sessions > 1
          ? 'Every run started here reads them when its Discover starts.'
          : 'The run reads them when its Discover starts.'}
      </p>
      <ConfigBar pipeline={props.pipeline} projectParams={props.projectParams} />
      <RunSettingsFields
        pipeline={props.pipeline}
        context="setup"
        frameWidth={props.frameWidth}
        projectParams={props.projectParams}
      />
      <section class="cala-sheet__slot" aria-label="Speed" data-testid="setup-speed">
        <SpeedControl
          pipeline={props.pipeline}
          cells={props.cells}
          live={props.live}
          fps={props.fps}
          setup={true}
        />
      </section>
      <SheetSlot id="repeatable" title="Repeatable runs" />
      <SheetSlot id="seed" title="Start from footprints of a past run" />
      <SheetSlot id="crop" title="Crop region" />
    </section>
  );
}
