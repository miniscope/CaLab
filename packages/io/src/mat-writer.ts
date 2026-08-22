// MATLAB Level-5 .mat writer (uncompressed). Inverse of mat-parser.ts.
//
// Writes a single real Float32 matrix as one named variable. MATLAB stores
// arrays column-major, so C-order (row-major) input is transposed on the way
// out; mat-parser flags the result fortranOrder:true and processNpyResult
// transposes it back, making writeMat -> parseMat a round trip.
//
// Uncompressed only: no zlib on write (a reader accepts uncompressed v5/v6).

const miINT8 = 1;
const miINT32 = 5;
const miUINT32 = 6;
const miSINGLE = 7;
const miMATRIX = 14;
const mxSINGLE = 7; // array class

/** Build a standard-format data element: 8-byte tag + data padded to 8 bytes. */
function element(mdtype: number, data: Uint8Array): Uint8Array {
  const padded = data.length + ((8 - (data.length % 8)) % 8);
  const buf = new Uint8Array(8 + padded);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, mdtype, true);
  dv.setUint32(4, data.length, true);
  buf.set(data, 8);
  return buf;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/**
 * Write a 2D Float32 matrix as an uncompressed MATLAB Level-5 .mat buffer.
 *
 * @param name - MATLAB variable name for the array
 * @param data - flat row-major (C-order) Float32 values, length rows*cols
 * @param shape - [rows, cols]
 * @returns ArrayBuffer containing the complete .mat file
 * @throws Error if data length does not match rows*cols
 */
export function writeMat(name: string, data: Float32Array, shape: [number, number]): ArrayBuffer {
  const [rows, cols] = shape;
  if (data.length !== rows * cols) {
    throw new Error(`writeMat: data length ${data.length} does not match shape ${rows}x${cols}`);
  }

  // 1. Array flags (miUINT32, 2 words): [class|flags, nzmax]. Low byte = class.
  const flagsData = new Uint8Array(8);
  new DataView(flagsData.buffer).setUint32(0, mxSINGLE, true);
  const flagsEl = element(miUINT32, flagsData);

  // 2. Dimensions (miINT32).
  const dimsData = new Uint8Array(8);
  const dimsView = new DataView(dimsData.buffer);
  dimsView.setInt32(0, rows, true);
  dimsView.setInt32(4, cols, true);
  const dimsEl = element(miINT32, dimsData);

  // 3. Array name (miINT8).
  const nameEl = element(miINT8, new TextEncoder().encode(name));

  // 4. Real part (miSINGLE), written column-major.
  const prData = new Uint8Array(rows * cols * 4);
  const prView = new DataView(prData.buffer);
  let k = 0;
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      prView.setFloat32(k, data[r * cols + c], true);
      k += 4;
    }
  }
  const prEl = element(miSINGLE, prData);

  const matrixEl = element(miMATRIX, concat([flagsEl, dimsEl, nameEl, prEl]));

  // 5. 128-byte header: descriptive text + version (0x0100) + endian 'IM' (LE).
  const header = new Uint8Array(128);
  const desc = 'MATLAB 5.0 MAT-file, created by CaLab';
  for (let i = 0; i < desc.length && i < 116; i++) header[i] = desc.charCodeAt(i);
  const headerView = new DataView(header.buffer);
  headerView.setUint16(124, 0x0100, true);
  header[126] = 0x49; // 'I'
  header[127] = 0x4d; // 'M'

  return concat([header, matrixEl]).buffer as ArrayBuffer;
}
