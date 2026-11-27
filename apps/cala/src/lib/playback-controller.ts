/**
 * Smooth playback of a run's previews (`lib/playback.ts`), for the pipeline store.
 *
 * With a preview of every frame of a batch (asked from the worker only for the view being shown,
 * and only at modest processing rates), the displayed frame advances evenly instead of in batch
 * jumps. `previews()`, and so the FOV's frame readout, follow the DISPLAYED frame; the cell
 * overlay and the trace cursor follow the processed one (`cells.frame()`), about a batch ahead.
 */
import { createSignal } from 'solid-js';
import type { PipelineClient } from './frame-client.ts';
import type { BatchPreviews } from './pipeline-types.ts';
import { PlaybackScheduler, playbackWanted } from './playback.ts';
import { framePreviewImage, type FrameView } from './preview.ts';

interface PlayedFrame {
  batch: BatchPreviews;
  index: number;
}

/** What playback reads from the pipeline store. */
export interface PlaybackDeps {
  client: Pick<PipelineClient, 'setFramePreview'>;
  /** Wall clock, ms (the display log's times). */
  clock: () => number;
  /** The run is paused (a tracked read of the store's status). */
  paused: () => boolean;
  /** The run's frame gate is paced (`paceFps` applies). */
  paceRun: () => boolean;
  /** The target speed, frames per second. */
  paceFps: () => number;
  /** The processing rate now, frames per second. */
  rate: () => number;
}

/** The previews shown in the FOV and their smooth playback. */
export function createPlaybackController(deps: PlaybackDeps) {
  const { client, clock } = deps;
  const [previews, setPreviews] = createSignal<BatchPreviews | null>(null);
  const playback = new PlaybackScheduler<PlayedFrame>();
  let smoothOn = true;
  /** The view the FOV shows, if it can be played (raw, preprocessed, corrected or output). */
  let playView: FrameView | null = null;
  /** The view the worker was last asked to preview for every frame. */
  let framesAsked: FrameView | null = null;
  let rafId: number | null = null;
  /** Frames are queued for playback: the displayed frame lags the processed one. */
  const [playing, setPlaying] = createSignal(false);
  let displayLogOn = false;
  let displayLog: { t: number; frame: number }[] = [];
  const hasRaf = typeof requestAnimationFrame === 'function';

  /** Show one played frame: its view's image, the batch's last-frame images for the other views. */
  function showPlayed(f: PlayedFrame): void {
    const fp = f.batch.frames!;
    setPreviews({
      ...f.batch,
      [fp.view]: framePreviewImage(fp, f.index),
      frame: fp.first + f.index,
      fit: { [fp.view]: f.batch[fp.view] },
    });
    if (displayLogOn) {
      displayLog.push({ t: clock(), frame: fp.first + f.index });
      // Bounded: past 20000 entries the oldest half is cut (a short measurement run never gets there).
      if (displayLog.length > 20000) displayLog = displayLog.slice(-10000);
    }
  }

  function playbackLoop(t: number): void {
    rafId = null;
    const f = playback.tick(t);
    if (f) showPlayed(f);
    if (playback.queued > 0) rafId = requestAnimationFrame(playbackLoop);
    else setPlaying(false);
  }

  function endPlayback(): void {
    if (rafId !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
    rafId = null;
    playback.clear();
    setPlaying(false);
  }

  /** Ask the worker for per-frame previews of the shown view, or stop asking, by the processing rate. */
  function syncFramePreview(rate: number): void {
    const want =
      smoothOn &&
      hasRaf &&
      client.setFramePreview &&
      playView &&
      playbackWanted(rate, framesAsked !== null)
        ? playView
        : null;
    if (want === framesAsked) return;
    framesAsked = want;
    void client.setFramePreview?.(want).catch(() => {});
  }

  /** A batch's previews arrived: queue its frames for playback, or show its last frame at once. */
  function offerPreviews(p: BatchPreviews, rate: number): void {
    const fp = p.frames;
    if (fp && hasRaf && smoothOn && fp.view === playView) {
      const items = Array.from({ length: fp.count }, (_, index) => ({ batch: p, index }));
      if (deps.paused()) {
        // Answers to steps sent before the pause: the newest frame, shown at once.
        playback.clear();
        showPlayed(items[items.length - 1]);
      } else {
        // Paced: the pace, unless processing cannot keep up with it (then the measured rate, so the
        // queue does not just fill and skip). Unpaced: a little above the measured rate.
        const measured = rate > 0 ? rate * 1.05 : Infinity;
        playback.setRate(
          deps.paceRun()
            ? Math.min(deps.paceFps(), measured)
            : Number.isFinite(measured)
              ? measured
              : 30,
        );
        playback.push(items);
        setPlaying(true);
        if (rafId === null) rafId = requestAnimationFrame(playbackLoop);
      }
    } else {
      endPlayback();
      setPreviews(p);
      if (displayLogOn) displayLog.push({ t: clock(), frame: p.frame });
    }
    syncFramePreview(rate);
  }

  /** The run paused: the newest queued frame at once; the rest of the queue is dropped. */
  function pause(): void {
    const newest = playback.flush();
    if (newest) showPlayed(newest);
    setPlaying(false);
  }

  /** A run starts or stops: no queue, no previews, no display log. */
  function reset(): void {
    endPlayback();
    framesAsked = null;
    displayLog = [];
    setPreviews(null);
  }

  return {
    /** The newest previews (the displayed frame's while playback lags the processed one). */
    previews,
    offerPreviews,
    syncFramePreview,
    pause,
    reset,
    /** Smooth playback is on. */
    smoothPlayback: () => smoothOn,
    /** The view the FOV shows (null: none, or one that is not a frame of the batch). */
    setPlayView: (view: FrameView | null) => {
      playView = view;
      if (view === null || view !== framesAsked) endPlayback();
      syncFramePreview(deps.rate());
    },
    /** Smooth playback on or off. */
    setSmoothPlayback: (on: boolean) => {
      smoothOn = on;
      if (!on) endPlayback();
      syncFramePreview(deps.rate());
    },
    /** Frames waiting for display, dropped by skipping ahead, and shown; the view being previewed. */
    playbackStats: () => ({
      queued: playback.queued,
      dropped: playback.dropped,
      shown: playback.shown,
      view: framesAsked,
    }),
    /** The frame on screen while playback lags the processed one (null otherwise). */
    displayedFrame: () => (playing() ? (previews()?.frame ?? null) : null),
    /** Record when each displayed frame changed (measurement). */
    setDisplayLog: (on: boolean) => {
      displayLogOn = on;
    },
    /** The display log (measurement). */
    displayLog: () => displayLog,
  };
}

/** The pipeline store's playback controller. */
export type PlaybackController = ReturnType<typeof createPlaybackController>;
