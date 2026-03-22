// .npy binary format writer
// Inverse of npy-parser.ts — serializes a Float32Array + shape into .npy format.
// Reference: https://numpy.org/doc/2.3/reference/generated/numpy.lib.format.html

/**
 * Write a Float32Array as a .npy binary buffer (version 1.0, little-endian float32).
 *
 * @param data - The flat Float32Array of values
 * @param shape - The array shape, e.g. [rows, cols]
 * @returns ArrayBuffer containing the complete .npy file
 */
export function writeNpy(data: Float32Array, shape: number[]): ArrayBuffer {
  // 1. Build header dict string
  const shapeStr = shape.length === 1 ? `(${shape[0]},)` : `(${shape.join(', ')})`;
  const headerDict = `{'descr': '<f4', 'fortran_order': False, 'shape': ${shapeStr}, }`;
  const headerBytes = new TextEncoder().encode(headerDict);

  // 2. Compute padding to 64-byte alignment
  const preambleLen = 10; // magic(6) + version(2) + headerLen(2)
  let totalHeaderLen = headerBytes.length + 1; // +1 for newline
  const remainder = (preambleLen + totalHeaderLen) % 64;
  if (remainder !== 0) {
    totalHeaderLen += 64 - remainder;
  }

  // 3. Allocate buffer
  const dataBytes = data.byteLength;
  const buffer = new ArrayBuffer(preambleLen + totalHeaderLen + dataBytes);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // 4. Magic bytes: \x93NUMPY
  bytes[0] = 0x93;
  bytes[1] = 0x4e; // N
  bytes[2] = 0x55; // U
  bytes[3] = 0x4d; // M
  bytes[4] = 0x50; // P
  bytes[5] = 0x59; // Y

  // 5. Version 1.0
  bytes[6] = 1;
  bytes[7] = 0;

  // 6. Header length (2 bytes, little-endian)
  view.setUint16(8, totalHeaderLen, true);

  // 7. Header string + space padding + newline
  const headerStart = preambleLen;
  bytes.set(headerBytes, headerStart);
  for (let i = headerBytes.length; i < totalHeaderLen - 1; i++) {
    bytes[headerStart + i] = 0x20; // space
  }
  bytes[headerStart + totalHeaderLen - 1] = 0x0a; // \n

  // 8. Raw data (copy Float32Array bytes)
  const dataOffset = preambleLen + totalHeaderLen;
  new Uint8Array(buffer, dataOffset, dataBytes).set(
    new Uint8Array(data.buffer, data.byteOffset, dataBytes),
  );

  return buffer;
}
