#!/usr/bin/env node
/**
 * Live-recording simulator: streams a Miniscope AVI folder over a WebSocket
 * at its frame rate, as an acquisition board would push frames while
 * recording. The app opens it with "stream from a live source" (or
 * `?live=ws://localhost:8765`) and runs its pipeline on the unbounded stream.
 *
 *   node apps/cala/scripts/live-sim.mjs <folder> [--port 8765] [--fps 20]
 *        [--frames N] [--drop 100,2500] [--buffer 50] [--out <dir>] [--quiet]
 *
 * Every connection gets the recording from its first frame, paced against a
 * fixed schedule (frame i goes out at t0 + i / fps, so a slow send does not
 * stretch the recording). `--drop` leaves out those frame indices (a camera
 * drop: the index jumps). `--buffer N`: when more than N frames are stuck in
 * the socket's send buffer (the client is not reading) the frame is dropped
 * instead of queued, as a board without a frame store would. `--out <dir>`
 * also accepts `POST /save/<name>` and writes the body to that directory
 * (the measurement script posts the app's export and metrics there).
 *
 * Protocol: see `src/lib/live-source.ts`. The WebSocket server is the few
 * lines of RFC 6455 a server needs (handshake, unmasked binary and text
 * frames out, close and ping in), so this script has no dependencies.
 *
 * Needs Node >= 22.18 (type stripping, for the .ts imports). The folder is
 * only ever read.
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createWriteStream, mkdirSync, openAsBlob, readdirSync, readFileSync } from 'node:fs';
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
const drops = new Set(
  (option('--drop', '') || '')
    .split(',')
    .filter((s) => s.trim() !== '')
    .map((s) => Number(s)),
);
const bufferFrames = Number(option('--buffer', '50'));
const outDir = option('--out', undefined);
const quiet = flag('--quiet');
const dir = resolve(args[0] ?? '.');

const here = import.meta.dirname;
const { initCalaWasm } = await import(resolve(here, '../src/lib/cala-wasm.ts'));
const { FrameSource, entriesFromFiles } = await import(resolve(here, '../src/lib/frame-source.ts'));
await initCalaWasm(readFileSync(resolve(here, '../../../crates/cala/pkg/calab_cala_bg.wasm')));

const names = readdirSync(dir).filter((n) => /\.(avi|json|csv)$/i.test(n));
const files = await Promise.all(
  names.map(async (name) => new File([await openAsBlob(join(dir, name))], name)),
);
const source = await FrameSource.open(entriesFromFiles(files));
const info = source.info;
const fps = fpsArg !== undefined ? Number(fpsArg) : (info.fps ?? 20);
const total = maxFrames > 0 ? Math.min(maxFrames, info.frameCount) : info.frameCount;
const px = info.width * info.height;
const bytesPerPixel = info.bitDepth === 16 ? 2 : 1;
const frameBytes = px * bytesPerPixel;
const log = (...a) => {
  if (!quiet) console.log(...a);
};
log(
  `live-sim: ${dir}: ${info.frameCount} frames ${info.width}x${info.height} ${info.bitDepth}-bit; ` +
    `streaming ${total} at ${fps} fps on ws://localhost:${port}` +
    (drops.size ? `, dropping ${[...drops].join(',')}` : ''),
);

// --- the WebSocket bits ------------------------------------------------------

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const HEADER_BYTES = 16;
const MAGIC = 0x464c4143; // 'CALF'

/** Frame header for a text (1) or binary (2) payload of `length` bytes, unmasked. */
function frameHeader(opcode, length) {
  if (length < 126) return Buffer.from([0x80 | opcode, length]);
  if (length < 65536) {
    const h = Buffer.alloc(4);
    h[0] = 0x80 | opcode;
    h[1] = 126;
    h.writeUInt16BE(length, 2);
    return h;
  }
  const h = Buffer.alloc(10);
  h[0] = 0x80 | opcode;
  h[1] = 127;
  h.writeBigUInt64BE(BigInt(length), 2);
  return h;
}

function sendText(socket, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  socket.write(Buffer.concat([frameHeader(1, body.length), body]));
}

function sendBinary(socket, parts) {
  const length = parts.reduce((n, p) => n + p.length, 0);
  socket.cork();
  socket.write(frameHeader(2, length));
  for (const p of parts) socket.write(p);
  socket.uncork();
}

/** Parse the client's (masked) frames out of `buf`; returns what is left and the control frames seen. */
function parseClientFrames(buf, onFrame) {
  let at = 0;
  for (;;) {
    if (buf.length - at < 2) break;
    const opcode = buf[at] & 0x0f;
    const masked = (buf[at + 1] & 0x80) !== 0;
    let len = buf[at + 1] & 0x7f;
    let p = at + 2;
    if (len === 126) {
      if (buf.length - p < 2) break;
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (buf.length - p < 8) break;
      len = Number(buf.readBigUInt64BE(p));
      p += 8;
    }
    const maskLen = masked ? 4 : 0;
    if (buf.length - p < maskLen + len) break;
    const mask = masked ? buf.subarray(p, p + 4) : null;
    const payload = Buffer.from(buf.subarray(p + maskLen, p + maskLen + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    onFrame(opcode, payload);
    at = p + maskLen + len;
  }
  return buf.subarray(at);
}

// --- streaming ---------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const CHUNK = 32;

let connections = 0;

async function stream(socket, id) {
  const stats = { sent: 0, dropped: 0, skipped: 0, lateMs: 0, maxLateMs: 0 };
  let open = true;
  socket.on('close', () => (open = false));
  socket.on('error', () => (open = false));
  sendText(socket, {
    type: 'hello',
    width: info.width,
    height: info.height,
    bitDepth: info.bitDepth,
    fps,
    fourcc: info.fourcc,
    bottomUp: info.bottomUp,
    name: basename(dir),
  });
  const interval = 1000 / fps;
  const head = Buffer.alloc(HEADER_BYTES);
  head.writeUInt32LE(MAGIC, 0);
  const t0 = performance.now();
  let chunk = null;
  let chunkStart = 0;
  let next = source.readFrames(0, Math.min(CHUNK, total));
  for (let i = 0; i < total && open; i++) {
    if (i >= chunkStart + (chunk ? chunk.length / px : 0)) {
      chunk = await next;
      chunkStart = i;
      const n = Math.min(CHUNK, total - (i + CHUNK));
      next = n > 0 ? source.readFrames(i + CHUNK, n) : null;
    }
    const due = t0 + i * interval;
    const wait = due - performance.now();
    if (wait > 0) await sleep(wait);
    if (!open) break;
    const late = performance.now() - due;
    stats.lateMs += late;
    stats.maxLateMs = Math.max(stats.maxLateMs, late);
    if (drops.has(i)) {
      stats.skipped++;
      continue;
    }
    if (socket.writableLength > bufferFrames * frameBytes) {
      stats.dropped++;
      continue;
    }
    head.writeUInt32LE(i, 4);
    head.writeDoubleLE(performance.timeOrigin + performance.now(), 8);
    const local = i - chunkStart;
    const pixels = Buffer.from(chunk.buffer, chunk.byteOffset + local * frameBytes, frameBytes);
    sendBinary(socket, [Buffer.from(head), pixels]);
    stats.sent++;
  }
  if (open) sendText(socket, { type: 'end', frames: stats.sent });
  const seconds = (performance.now() - t0) / 1000;
  log(
    `live-sim #${id}: sent ${stats.sent} frames in ${seconds.toFixed(1)} s ` +
      `(${(stats.sent / seconds).toFixed(2)} fps), dropped ${stats.dropped} (send buffer), ` +
      `skipped ${stats.skipped} (--drop), mean lateness ${(stats.lateMs / Math.max(1, total)).toFixed(2)} ms, ` +
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
      log(`live-sim: saved ${path}`);
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
    `cala live-sim: ${basename(dir)}, ${total} frames at ${fps} fps. Connect a WebSocket here.\n`,
  );
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if ((req.headers.upgrade ?? '').toLowerCase() !== 'websocket' || !key) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  const accept = createHash('sha1')
    .update(key + GUID)
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.setNoDelay(true);
  const id = ++connections;
  log(`live-sim #${id}: client connected`);
  let pending = Buffer.alloc(0);
  socket.on('data', (data) => {
    pending = parseClientFrames(Buffer.concat([pending, data]), (opcode, payload) => {
      if (opcode === 8) {
        socket.write(Buffer.concat([frameHeader(8, payload.length), payload]));
        socket.end();
      } else if (opcode === 9) {
        socket.write(Buffer.concat([frameHeader(10, payload.length), payload]));
      }
    });
  });
  socket.on('error', () => {});
  stream(socket, id).catch((err) => {
    console.error(`live-sim #${id}: ${err.message}`);
    socket.destroy();
  });
});

server.listen(port, () => log(`live-sim: listening on ws://localhost:${port}`));
