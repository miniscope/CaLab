#!/usr/bin/env node
/**
 * Simulated live stream (`npm run sim-stream -- <path>`): replays a recording
 * over a WebSocket at a chosen frame rate, as an acquisition board would push
 * frames while recording, so cala's live source can be tested without
 * hardware. Cala opens it with the start page's "stream from a live source"
 * field (paste the printed ws:// URL) or `?live=ws://localhost:8765`.
 *
 *   npm run sim-stream -- <path> [--port 8765] [--fps 20] [--start N]
 *        [--frames N] [--loop] [--drop 100,2500] [--buffer 50] [--out <dir>]
 *        [--quiet]
 *
 * <path> is a Miniscope AVI folder (the AVIs, metaData.json and timeStamps.csv
 * together), or a minisim recording: the sim directory (`$SIM_MOTION_S5`), its
 * `daq/` or its `daq/Miniscope/`. A directory with no AVIs is searched for
 * one `Miniscope` folder, so each of those resolves to the same recording.
 *
 * `--fps` defaults to the recording's metadata (20 without any). `--start N`
 * begins at recording frame N, `--frames N` stops after N frames, and `--loop`
 * wraps from the last frame back to the first until stopped (the frame index
 * the app sees keeps counting up, as a real acquisition's does).
 *
 * Every connection gets the recording from its start, paced against a fixed
 * schedule (frame k goes out at t0 + k / fps, so a slow send does not stretch
 * the recording). `--drop` leaves out those frame indices (a camera drop: the
 * index jumps). `--buffer N`: when more than N frames are stuck in the
 * socket's send buffer (the client is not reading) the frame is dropped
 * instead of queued, as a board without a frame store would. `--out <dir>`
 * also accepts `POST /save/<name>` and writes the body to that directory
 * (the measurement script posts the app's export and metrics there).
 *
 * Protocol: see `src/lib/live-source.ts`; the sending side is
 * `src/lib/live-sim-protocol.ts` (the few lines of RFC 6455 a server needs),
 * so this script has no dependencies.
 *
 * Needs Node >= 22.18 (type stripping, for the .ts imports). The recording is
 * only ever read.
 */
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  openAsBlob,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { basename, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const args = process.argv.slice(2);
function option(name, fallback) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const [, value] = args.splice(i, 2);
  return value ?? fallback;
}
function flag(name) {
  const i = args.indexOf(name);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
}
const port = Number(option('--port', '8765'));
const fpsArg = option('--fps', undefined);
const maxFrames = Number(option('--frames', '0'));
const startFrame = Number(option('--start', '0'));
const loop = flag('--loop');
const drops = new Set(
  (option('--drop', '') || '')
    .split(',')
    .filter((s) => s.trim() !== '')
    .map((s) => Number(s)),
);
const bufferFrames = Number(option('--buffer', '50'));
const outDir = option('--out', undefined);
const quiet = flag('--quiet');
const log = (...a) => {
  if (!quiet) console.log(...a);
};
const fail = (message) => {
  console.error(`sim-stream: ${message}`);
  process.exit(1);
};
if (args.length === 0 || args[0].startsWith('-')) {
  fail(
    'usage: npm run sim-stream -- <folder> [--port N] [--fps N] [--start N] [--frames N] [--loop]',
  );
}

/** The folder holding the AVIs: `dir` itself, or the `Miniscope` folder below a minisim sim or its `daq/`. */
function findRecording(dir) {
  const hasAvi = (d) => existsSync(d) && readdirSync(d).some((n) => /\.avi$/i.test(n));
  for (const candidate of [dir, join(dir, 'Miniscope'), join(dir, 'daq', 'Miniscope')]) {
    if (hasAvi(candidate)) return candidate;
  }
  return null;
}
const requested = resolve(args[0]);
if (!existsSync(requested)) fail(`${requested} does not exist`);
const dir = findRecording(requested);
/** The recording's name for the app: the sim folder, not its `daq` or `Miniscope` subfolder. */
const recordingName =
  requested
    .split('/')
    .filter((s) => s && !/^(daq|Miniscope)$/i.test(s))
    .pop() ?? basename(requested);
if (!dir) fail(`no .avi files in ${requested}, nor in its Miniscope/ or daq/Miniscope/`);

const here = import.meta.dirname;
const { initCalaWasm } = await import(resolve(here, '../src/lib/cala-wasm.ts'));
const { FrameSource, entriesFromFiles } = await import(resolve(here, '../src/lib/frame-source.ts'));
const proto = await import(resolve(here, '../src/lib/live-sim-protocol.ts'));
await initCalaWasm(readFileSync(resolve(here, '../../../crates/cala/pkg/calab_cala_bg.wasm')));

const names = readdirSync(dir).filter((n) => /\.(avi|json|csv)$/i.test(n));
const files = await Promise.all(
  names.map(async (name) => new File([await openAsBlob(join(dir, name))], name)),
);
const source = await FrameSource.open(entriesFromFiles(files));
const info = source.info;
const fps = fpsArg !== undefined ? Number(fpsArg) : (info.fps ?? 20);
if (!(fps > 0)) fail(`invalid --fps ${fpsArg}`);
if (!(startFrame >= 0 && startFrame < info.frameCount)) {
  fail(`--start ${startFrame} is outside the recording (${info.frameCount} frames)`);
}
/** Frames streamed per connection: to the end (or --frames), or forever with --loop and no --frames. */
const total = loop
  ? maxFrames > 0
    ? maxFrames
    : Infinity
  : Math.min(maxFrames > 0 ? maxFrames : Infinity, info.frameCount - startFrame);
const px = info.width * info.height;
const bytesPerPixel = info.bitDepth === 16 ? 2 : 1;
const frameBytes = px * bytesPerPixel;
const url = `ws://localhost:${port}`;
log(
  `sim-stream: ${dir}\n` +
    `  ${info.frameCount} frames ${info.width}x${info.height} ${info.bitDepth}-bit; ` +
    `streaming ${total === Infinity ? 'forever' : total} at ${fps} fps from frame ${startFrame}` +
    (loop ? ' (looping)' : '') +
    (drops.size ? `, dropping ${[...drops].join(',')}` : ''),
);

// --- streaming ---------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const CHUNK = 32;

let connections = 0;

/** Up to CHUNK recording frames for stream position `k` (never across the recording's end: that is the wrap). */
function readChunk(k) {
  const at = (startFrame + k) % info.frameCount;
  const n = Math.min(CHUNK, info.frameCount - at, total - k);
  return source.readFrames(at, n).then((data) => ({ k, n, data }));
}

async function stream(socket, id) {
  const stats = { sent: 0, dropped: 0, skipped: 0, lateMs: 0, maxLateMs: 0 };
  let open = true;
  socket.on('close', () => (open = false));
  socket.on('error', () => (open = false));
  socket.write(
    proto.textFrame({
      type: 'hello',
      width: info.width,
      height: info.height,
      bitDepth: info.bitDepth,
      fps,
      fourcc: info.fourcc,
      bottomUp: info.bottomUp,
      name: recordingName,
    }),
  );
  const interval = 1000 / fps;
  const t0 = performance.now();
  let chunk = null;
  let next = readChunk(0);
  let k = 0;
  for (; k < total && open; k++) {
    if (!chunk || k >= chunk.k + chunk.n) {
      chunk = await next;
      const after = chunk.k + chunk.n;
      next = after < total ? readChunk(after) : null;
    }
    const due = t0 + k * interval;
    const wait = due - performance.now();
    if (wait > 0) await sleep(wait);
    if (!open) break;
    const late = performance.now() - due;
    stats.lateMs += late;
    stats.maxLateMs = Math.max(stats.maxLateMs, late);
    if (drops.has(k)) {
      stats.skipped++;
      continue;
    }
    if (socket.writableLength > bufferFrames * frameBytes) {
      stats.dropped++;
      continue;
    }
    const local = k - chunk.k;
    const pixels = new Uint8Array(
      chunk.data.buffer,
      chunk.data.byteOffset + local * frameBytes,
      frameBytes,
    );
    socket.write(proto.binaryFrame(k, performance.timeOrigin + performance.now(), pixels));
    stats.sent++;
  }
  if (open) socket.write(proto.textFrame({ type: 'end', frames: stats.sent }));
  const seconds = (performance.now() - t0) / 1000;
  log(
    `sim-stream #${id}: sent ${stats.sent} frames in ${seconds.toFixed(1)} s ` +
      `(${(stats.sent / seconds).toFixed(2)} fps), dropped ${stats.dropped} (send buffer), ` +
      `skipped ${stats.skipped} (--drop), mean lateness ${(stats.lateMs / Math.max(1, k)).toFixed(2)} ms, ` +
      `max ${stats.maxLateMs.toFixed(1)} ms`,
  );
}

const server = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.end();
  const save = /^\/save\/([A-Za-z0-9._-]+)$/.exec(req.url ?? '');
  if (req.method === 'POST' && save) {
    if (!outDir) {
      res.statusCode = 403;
      return res.end('start the simulator with --out <dir> to accept files');
    }
    mkdirSync(outDir, { recursive: true });
    const path = join(outDir, save[1]);
    const out = createWriteStream(path);
    req.pipe(out);
    out.on('finish', () => {
      log(`sim-stream: saved ${path}`);
      res.end('ok');
    });
    out.on('error', (err) => {
      res.statusCode = 500;
      res.end(String(err));
    });
    return;
  }
  res.setHeader('Content-Type', 'text/plain');
  res.end(
    `cala sim-stream: ${recordingName}, ${total} frames at ${fps} fps. Connect a WebSocket here.\n`,
  );
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if ((req.headers.upgrade ?? '').toLowerCase() !== 'websocket' || !key) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  const accept = proto.acceptKey(key);
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.setNoDelay(true);
  const id = ++connections;
  log(`sim-stream #${id}: client connected`);
  let pending = Buffer.alloc(0);
  socket.on('data', (data) => {
    pending = proto.parseClientFrames(Buffer.concat([pending, data]), (opcode, payload) => {
      if (opcode === proto.OP_CLOSE) {
        socket.write(proto.controlFrame(proto.OP_CLOSE, payload));
        socket.end();
      } else if (opcode === proto.OP_PING) {
        socket.write(proto.controlFrame(proto.OP_PONG, payload));
      }
    });
  });
  socket.on('error', () => {});
  stream(socket, id).catch((err) => {
    console.error(`sim-stream #${id}: ${err.message}`);
    socket.destroy();
  });
});

server.on('error', (err) =>
  fail(err.code === 'EADDRINUSE' ? `port ${port} is in use (try --port)` : err.message),
);
server.listen(port, () => {
  log(`sim-stream: listening on ${url}`);
  log(`sim-stream: paste ${url} into the live-source field in cala (or open ?live=${url})`);
});
