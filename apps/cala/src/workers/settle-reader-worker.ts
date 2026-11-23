/**
 * A Final-settle reader (`lib/settle-readers.ts`): started by look-back
 * worker 0 when the Final settle begins, ended when it ends. It reads the
 * plan's frames from its own `FrameSource` (the same `File`s) and does their
 * stateless half (`prepareFrame`: recorded flicker, flat field, session warp,
 * rigid shift) into the buffer worker 0 sent, which goes back with them.
 * Worker 0 keeps the back half and the solve.
 */
import { initCalaWasm, Preprocessor, SessionAligner } from '../lib/cala-wasm.ts';
import type { FlatFieldMap } from '../lib/flat-field.ts';
import { FrameSource, type FramePixels } from '../lib/frame-source.ts';
import { prepareFrame, replayMotion } from '../lib/lookback-reader.ts';
import type { FromSettleReader, ToSettleReader } from '../lib/settle-readers.ts';

const scope = globalThis as unknown as {
  postMessage(msg: FromSettleReader, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<ToSettleReader>) => void) | null;
};

interface State {
  src: FrameSource;
  front: Preprocessor;
  motion: ReturnType<typeof replayMotion>;
  aligner: SessionAligner | null;
  warp: [number, number, number] | null;
  flatSeq: number;
  raw: FramePixels;
  buf: Float32Array;
  px: number;
}

let st: State | null = null;
let queue: Promise<void> = Promise.resolve();

/** The flat field on the front half, as worker 0 sets it (`LookbackReader.frontPre`). */
function applyFlat(front: Preprocessor, map: FlatFieldMap | null): void {
  if (map) front.setFlatField(map.gain, map.offset.length > 0 ? map.offset : undefined, map.dark);
}

async function init(msg: Extract<ToSettleReader, { type: 'init' }>): Promise<void> {
  await initCalaWasm();
  const src =
    'entries' in msg.source
      ? await FrameSource.open(msg.source.entries)
      : await FrameSource.openSessions(msg.source.sessions);
  const { width, height, bitDepth } = src.info;
  const px = width * height;
  const front = Preprocessor.fromState(msg.front);
  applyFlat(front, msg.flat);
  st = {
    src,
    front,
    motion: replayMotion(width, height),
    aligner: null,
    warp: null,
    flatSeq: msg.flatSeq,
    raw: bitDepth === 16 ? new Uint16Array(0) : new Uint8Array(0),
    buf: new Float32Array(px),
    px,
  };
  scope.postMessage({ type: 'ready' });
}

/** The session warp of a frame (null: none), set on the aligner only when it changes. */
function aligner(s: State, warp: Float32Array, i: number): SessionAligner | null {
  const t: [number, number, number] = [warp[3 * i], warp[3 * i + 1], warp[3 * i + 2]];
  if (t[0] === 0 && t[1] === 0 && t[2] === 0) return null;
  const { width, height } = s.src.info;
  const a = (s.aligner ??= new SessionAligner(width, height));
  if (!s.warp || s.warp[0] !== t[0] || s.warp[1] !== t[1] || s.warp[2] !== t[2]) {
    a.setTransform(t[0], t[1], t[2]);
    s.warp = t;
  }
  return a;
}

async function job(msg: Extract<ToSettleReader, { type: 'job' }>): Promise<void> {
  const s = st;
  if (!s) throw new Error('settle reader: a job before init');
  const t0 = performance.now();
  const { job: j, buf } = msg;
  const n = j.frames.length;
  if (buf.length < n * s.px) throw new RangeError(`settle reader: ${buf.length} for ${n} frames`);
  // Consecutive frames are read at once.
  let i = 0;
  while (i < n) {
    let k = i + 1;
    while (k < n && j.frames[k] === j.frames[k - 1] + 1) k++;
    const count = k - i;
    if (s.raw.length < count * s.px)
      s.raw = s.raw instanceof Uint16Array ? new Uint16Array(n * s.px) : new Uint8Array(n * s.px);
    const got = await s.src.readFrames(j.frames[i], count, s.raw.subarray(0, count * s.px));
    for (let f = 0; f < count; f++) {
      const at = i + f;
      prepareFrame(
        s.front,
        aligner(s, j.warp, at),
        s.motion,
        got.subarray(f * s.px, (f + 1) * s.px),
        {
          dy: j.dy.subarray(at, at + 1),
          dx: j.dx.subarray(at, at + 1),
          flags: j.flags.subarray(at, at + 1),
          flickerOffset: j.flickerOffset.subarray(at, at + 1),
          flickerGain: j.flickerGain.subarray(at, at + 1),
        },
        s.buf,
        buf.subarray(at * s.px, (at + 1) * s.px),
      );
    }
    i = k;
  }
  scope.postMessage(
    { type: 'done', id: msg.id, buf, flatSeq: s.flatSeq, busyMs: performance.now() - t0 },
    [buf.buffer as ArrayBuffer],
  );
}

function handle(msg: ToSettleReader): Promise<void> {
  switch (msg.type) {
    case 'init':
      return init(msg);
    case 'flat':
      if (st) {
        applyFlat(st.front, msg.map);
        st.flatSeq = msg.seq;
      }
      return Promise.resolve();
    case 'job':
      return job(msg);
  }
}

scope.onmessage = (e) => {
  const msg = e.data;
  queue = queue
    .then(() => handle(msg))
    .catch((err: unknown) => {
      scope.postMessage({
        type: 'error',
        ...(msg.type === 'job' ? { id: msg.id } : {}),
        message: err instanceof Error ? err.message : String(err),
      });
    });
};
