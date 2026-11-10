// .npy binary format writer
// Inverse of npy-parser.ts — serializes a Float32Array + shape into .npy format.
// Reference: https://numpy.org/doc/2.3/reference/generated/numpy.lib.format.html

/** Typed arrays `writeNpy` can serialize, and the numpy dtype each becomes (little-endian). */
export type NpyWritable =
  | Float32Array
  | Float64Array
  | Int32Array
  | Uint32Array
  | Int16Array
  | Uint16Array
  | Int8Array
  | Uint8Array;

function descrOf(data: NpyWritable): string {
  if (data instanceof Float32Array) return '<f4';
  if (data instanceof Float64Array) return '<f8';
  if (data instanceof Int32Array) return '<i4';
  if (data instanceof Uint32Array) return '<u4';
  if (data instanceof Int16Array) return '<i2';
  if (data instanceof Uint16Array) return '<u2';
  if (data instanceof Int8Array) return '|i1';
  return '|u1';
}

/** The numpy `descr` of a typed array. */
export function npyDescr(data: NpyWritable): string {
  return descrOf(data);
}

/**
 * The header (magic, version 1.0, length, dict, padding, newline) of a .npy
 * file, padded to a 64-byte multiple. The data follows it directly. With
 * `fortranOrder` the first axis varies fastest, so a (rows, cols) array is
 * written column after column: a frame-major stream of a cells x frames
 * matrix needs no transpose.
 */
export function writeNpyHeader(
  descr: string,
  shape: number[],
  fortranOrder = false,
): Uint8Array<ArrayBuffer> {
  const shapeStr = shape.length === 1 ? `(${shape[0]},)` : `(${shape.join(', ')})`;
  const headerDict = `{'descr': '${descr}', 'fortran_order': ${fortranOrder ? 'True' : 'False'}, 'shape': ${shapeStr}, }`;
  const headerBytes = new TextEncoder().encode(headerDict);
  const preambleLen = 10; // magic(6) + version(2) + headerLen(2)
  let totalHeaderLen = headerBytes.length + 1; // +1 for newline
  const remainder = (preambleLen + totalHeaderLen) % 64;
  if (remainder !== 0) totalHeaderLen += 64 - remainder;
  if (totalHeaderLen > 0xffff) throw new RangeError('.npy header too long for format 1.0');
  const out = new Uint8Array(preambleLen + totalHeaderLen);
  out.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0]); // \x93NUMPY, version 1.0
  new DataView(out.buffer).setUint16(8, totalHeaderLen, true);
  out.set(headerBytes, preambleLen);
  out.fill(0x20, preambleLen + headerBytes.length, preambleLen + totalHeaderLen - 1);
  out[preambleLen + totalHeaderLen - 1] = 0x0a;
  return out;
}

/**
 * Write a typed array as a .npy binary buffer (version 1.0, little-endian). A
 * Float32Array (the default case) becomes float32; integer arrays keep their
 * width and signedness.
 *
 * @param data - The flat typed array of values
 * @param shape - The array shape, e.g. [rows, cols]
 * @returns ArrayBuffer containing the complete .npy file
 */
export function writeNpy(data: NpyWritable, shape: number[]): ArrayBuffer {
  const header = writeNpyHeader(descrOf(data), shape);
  const buffer = new ArrayBuffer(header.length + data.byteLength);
  const bytes = new Uint8Array(buffer);
  bytes.set(header);
  bytes.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), header.length);
  return buffer;
}
