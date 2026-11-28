/**
 * The cell choir: while it is on, each cell that fires sings one soft note. Its stereo position
 * is the cell's x in the field of view (left to right), its pitch the cell's y (top high, bottom
 * low) on a pentatonic scale, so a region of the field always sounds the same. Fed by the 2 Hz
 * activity sampler (`activity.ts`), never per frame; notes are scheduled on the audio clock
 * across the half second so the sound is not a 2 Hz pulse.
 *
 * Silent until the user turns it on (the AudioContext is created in that key or click handler),
 * at most `MAX_VOICES` notes per tick, a low master gain, and `stop()` closes the context.
 */

/** Notes per 2 Hz tick at most (the most active onsets win). */
export const MAX_VOICES = 6;
/** Master gain (a quiet background, well under full scale). */
export const MASTER_GAIN = 0.12;

/** Major pentatonic steps (semitones) over three octaves from A2 (110 Hz). */
const PENTA = [0, 2, 4, 7, 9];
const ROOT_HZ = 110;
const OCTAVES = 3;

/** Pitch of a cell at relative height `yRel` (0 top .. 1 bottom): higher up = higher note. */
export function pitchHz(yRel: number): number {
  const steps = PENTA.length * OCTAVES;
  const i = Math.round((1 - Math.min(1, Math.max(0, yRel))) * (steps - 1));
  const semis = 12 * Math.floor(i / PENTA.length) + PENTA[i % PENTA.length];
  return ROOT_HZ * 2 ** (semis / 12);
}

/** Stereo pan of a cell at relative x `xRel` (0 left .. 1 right), kept off the hard edges. */
export const panOf = (xRel: number): number => 0.8 * (2 * Math.min(1, Math.max(0, xRel)) - 1);

export interface ChoirNote {
  xRel: number;
  yRel: number;
  /** 0..1, the note's loudness share. */
  strength: number;
}

type Ctx = AudioContext;

export function createChoir() {
  let ctx: Ctx | null = null;
  let master: GainNode | null = null;

  return {
    /** Start the audio (call inside the user's key or click handler). False when not available. */
    start(): boolean {
      if (ctx) return true;
      const AC =
        (globalThis as { AudioContext?: typeof AudioContext }).AudioContext ??
        (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return false;
      try {
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = MASTER_GAIN;
        master.connect(ctx.destination);
        void ctx.resume();
        // A soft two-note greeting, so turning it on is heard even when nothing fires yet.
        this.play([
          { xRel: 0.3, yRel: 0.6, strength: 0.6 },
          { xRel: 0.7, yRel: 0.3, strength: 0.6 },
        ]);
        return true;
      } catch {
        ctx = null;
        master = null;
        return false;
      }
    },
    get running(): boolean {
      return ctx !== null;
    },
    /** Sing these notes, spread over the next `spreadS` seconds. */
    play(notes: readonly ChoirNote[], spreadS = 0.45): void {
      if (!ctx || !master) return;
      const now = ctx.currentTime;
      const picked = [...notes].sort((a, b) => b.strength - a.strength).slice(0, MAX_VOICES);
      picked.forEach((n, k) => {
        const t = now + 0.02 + (spreadS * k) / Math.max(1, picked.length);
        const osc = ctx!.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = pitchHz(n.yRel);
        const g = ctx!.createGain();
        const peak = 0.25 + 0.5 * Math.min(1, Math.max(0, n.strength));
        // A calcium-like envelope: quick rise, slow decay.
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(peak, t + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0005, t + 1.1);
        const pan = ctx!.createStereoPanner?.();
        osc.connect(g);
        if (pan) {
          pan.pan.value = panOf(n.xRel);
          g.connect(pan);
          pan.connect(master!);
        } else g.connect(master!);
        osc.start(t);
        osc.stop(t + 1.2);
      });
    },
    stop(): void {
      const c = ctx;
      ctx = null;
      master = null;
      void c?.close().catch(() => {});
    },
  };
}

export type Choir = ReturnType<typeof createChoir>;

let page: Choir | null = null;
/** The page's one choir. */
export function pageChoir(): Choir {
  page ??= createChoir();
  return page;
}
