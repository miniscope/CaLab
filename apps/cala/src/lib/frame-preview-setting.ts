import type { FrameView } from './preview.ts';

/**
 * The view previewed for every frame (smooth playback), as the frame worker
 * holds it. It belongs to one Discover run: every run start clears it (the
 * store asks again once the run is up), and a replay (Refine, Extract) never
 * has it, whatever is asked while it runs.
 */
export class FramePreviewSetting {
  private view: FrameView | null = null;
  private replay = false;

  /** A pipeline run starts. */
  startRun(replay: boolean): void {
    this.view = null;
    this.replay = replay;
  }

  /** The store asks for a view (null: the last frame only). */
  set(view: FrameView | null): void {
    this.view = this.replay ? null : view;
  }

  get current(): FrameView | null {
    return this.view;
  }
}
