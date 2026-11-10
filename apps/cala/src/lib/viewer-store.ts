/**
 * Viewer state: the opened recording, the current frame, playback.
 *
 * Frame requests are latest-wins: while one read is in flight only the most
 * recent wanted index is kept, so dragging the slider never queues a backlog.
 */
import { createSignal, onCleanup } from 'solid-js';
import type { FrameClient } from './frame-client.ts';
import type { FolderEntry, FramePixels, FrameSourceInfo } from './frame-source.ts';

/** Playback rate when the recording has neither timestamps nor metadata. */
export const FALLBACK_PLAYBACK_FPS = 20;

export interface CurrentFrame {
  index: number;
  pixels: FramePixels;
}

export function createViewerStore(client: FrameClient) {
  const [info, setInfo] = createSignal<FrameSourceInfo | null>(null);
  const [label, setLabel] = createSignal('');
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [frameIndex, setFrameIndex] = createSignal(0);
  const [frame, setFrame] = createSignal<CurrentFrame | null>(null);
  const [playing, setPlaying] = createSignal(false);
  const [autoContrast, setAutoContrast] = createSignal(true);

  let inFlight = false;
  let wanted: number | null = null;
  let raf = 0;
  let generation = 0; // bumps on open/close, so stale reads are dropped

  async function pump(): Promise<void> {
    if (inFlight || wanted === null) return;
    const index = wanted;
    wanted = null;
    inFlight = true;
    const gen = generation;
    try {
      const pixels = await client.readFrame(index);
      if (gen === generation) setFrame({ index, pixels });
    } catch (err) {
      if (gen === generation) {
        setPlaying(false);
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      inFlight = false;
      if (wanted !== null) void pump();
    }
  }

  function showFrame(index: number): void {
    const n = info()?.frameCount ?? 0;
    if (n === 0) return;
    const clamped = Math.min(Math.max(Math.round(index), 0), n - 1);
    setFrameIndex(clamped);
    wanted = clamped;
    void pump();
  }

  function pause(): void {
    setPlaying(false);
    cancelAnimationFrame(raf);
  }

  function play(): void {
    const i = info();
    if (!i || playing()) return;
    if (frameIndex() >= i.frameCount - 1) showFrame(0);
    setPlaying(true);
    let last = performance.now();
    const tick = (now: number) => {
      if (!playing()) return;
      const interval = 1000 / (info()?.fps ?? FALLBACK_PLAYBACK_FPS);
      // Wait for the previous frame so a slow disk slows playback instead of
      // building a queue.
      if (!inFlight && now - last >= interval) {
        last = now;
        const next = frameIndex() + 1;
        if (next >= (info()?.frameCount ?? 0)) {
          pause();
          return;
        }
        showFrame(next);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }

  async function openFiles(entries: FolderEntry[], name: string): Promise<void> {
    pause();
    generation++;
    setError(null);
    setLoading(true);
    try {
      const opened = await client.open(entries);
      setInfo(opened);
      setLabel(name);
      setFrame(null);
      showFrame(0);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  /** Connect to a live source; the frames shown come from the pipeline's previews. */
  async function openLive(url: string): Promise<void> {
    pause();
    generation++;
    setError(null);
    setLoading(true);
    try {
      if (!client.openLive) throw new Error('This frame client cannot open a live source.');
      const opened = await client.openLive(url);
      setInfo(opened);
      setLabel(opened.live?.name ?? url);
      setFrame(null);
      setFrameIndex(0);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  function close(): void {
    pause();
    generation++;
    wanted = null;
    setInfo(null);
    setFrame(null);
    setFrameIndex(0);
    setError(null);
  }

  onCleanup(() => {
    pause();
    client.dispose();
  });

  return {
    info,
    label,
    loading,
    error,
    frameIndex,
    frame,
    playing,
    autoContrast,
    setAutoContrast,
    openFiles,
    openLive,
    showFrame,
    play,
    pause,
    togglePlay: () => (playing() ? pause() : play()),
    close,
  };
}

export type ViewerStore = ReturnType<typeof createViewerStore>;
