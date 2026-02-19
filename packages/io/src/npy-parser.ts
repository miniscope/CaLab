// .npy binary format parser
// Parses NumPy .npy files into typed arrays with shape, dtype, and fortran_order metadata.
// Reference: https://numpy.org/doc/2.3/reference/generated/numpy.lib.format.html

import type { NpyResult, NumericTypedArray } from '@calab/core';

// Magic bytes: \x93NUMPY
const NPY_MAGIC = new Uint8Array([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]);

// Dtype descriptor -> TypedArray constructor + byte size
interface DtypeInfo {
  constructor: new (buffer: ArrayBuffer, byteOffset: number, length: number) => NumericTypedArray;
  bytes: number;
}

const DTYPE_MAP: Record<string, DtypeInfo> = {
  '<f8': { constructor: Float64Array, bytes: 8 },
  '<f4': { constructor: Float32Array, bytes: 4 },
  '<i4': { constructor: Int32Array, bytes: 4 },
  '<i2': { constructor: Int16Array, bytes: 2 },
  '<i1': { constructor: Int8Array, bytes: 1 },
  '|i1': { constructor: Int8Array, bytes: 1 },
  '<u4': { constructor: Uint32Array, bytes: 4 },
  '<u2': { constructor: Uint16Array, bytes: 2 },
  '<u1': { constructor: Uint8Array, bytes: 1 },
  '|u1': { constructor: Uint8Array, bytes: 1 },
};

/**
 * Parse a .npy binary buffer into a typed array with metadata.
 *
 * @param buffer - The raw ArrayBuffer from reading a .npy file
 * @returns NpyResult with typed data array, shape, dtype string, and fortran_order flag
 * @throws Error for invalid magic bytes, big-endian, unsupported dtype, truncated files, or corrupted headers
 */
export function parseNpy(buffer: ArrayBuffer): NpyResult {
  // Guard: buffer must be at least large enough for magic + version
  if (buffer.byteLength < 8) {
    throw new Error('Not a valid .npy file: file too small');
  }

  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // 1. Verify magic bytes: \x93NUMPY
  for (let i = 0; i < NPY_MAGIC.length; i++) {
    if (bytes[i] !== NPY_MAGIC[i]) {
      throw new Error('Not a valid .npy file: incorrect magic bytes');
    }
  }

  // 2. Read version
  const majorVersion = view.getUint8(6);
  const minorVersion = view.getUint8(7);

  // 3. Read header length (2 bytes for v1.0, 4 bytes for v2.0+)
  let headerLen: number;
  let headerOffset: number;

  if (majorVersion === 1) {
    if (buffer.byteLength < 10) {
      throw new Error('Not a valid .npy file: file too small for v1 header');
    }
    headerLen = view.getUint16(8, true); // little-endian
    headerOffset = 10;
  } else if (majorVersion >= 2) {
    if (buffer.byteLength < 12) {
      throw new Error('Not a valid .npy file: file too small for v2 header');
    }
    headerLen = view.getUint32(8, true); // little-endian, 4 bytes
    headerOffset = 12;
  } else {
    throw new Error(`Unsupported .npy version: ${majorVersion}.${minorVersion}`);
  }

  // 4. Parse header string (Python dict literal as ASCII)
  if (buffer.byteLength < headerOffset + headerLen) {
    throw new Error('Not a valid .npy file: file truncated in header');
  }
  const headerBytes = new Uint8Array(buffer, headerOffset, headerLen);
  const headerStr = new TextDecoder('ascii').decode(headerBytes).trim();

  // 5. Extract dict values via regex (safe string matching, no code execution)
  const descr = headerStr.match(/'descr'\s*:\s*'([^']+)'/)?.[1];
  const fortranMatch = headerStr.match(/'fortran_order'\s*:\s*(True|False)/)?.[1];
  const shapeMatch = headerStr.match(/'shape'\s*:\s*\(([^)]*)\)/)?.[1];

  if (!descr || !fortranMatch || shapeMatch === undefined || shapeMatch === null) {
    throw new Error(`Failed to parse .npy header: ${headerStr}`);
  }

  const fortranOrder = fortranMatch === 'True';
  const shape = shapeMatch
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map(Number);

  // 6. Check for big-endian
  if (descr.startsWith('>')) {
    throw new Error(
      'Big-endian arrays are not supported. Re-save with: ' +
        'arr = numpy.ascontiguousarray(arr.astype(arr.dtype.newbyteorder("<")))',
    );
  }

  // 7. Look up dtype
  const dtypeInfo = DTYPE_MAP[descr];
  if (!dtypeInfo) {
    throw new Error(
      `Unsupported dtype "${descr}". CaTune requires numeric arrays ` +
        `(float32, float64, or integer types).`,
    );
  }

  // 8. Compute data offset and validate size
  const dataOffset = headerOffset + headerLen;
  const expectedElements = shape.length > 0 ? shape.reduce((a, b) => a * b, 1) : 0;
  const expectedBytes = expectedElements * dtypeInfo.bytes;
  const actualBytes = buffer.byteLength - dataOffset;

  if (actualBytes < expectedBytes) {
    throw new Error(
      `File truncated: expected ${expectedBytes} bytes of data ` +
        `but only ${actualBytes} available`,
    );
  }

  // 9. Create typed array (zero-copy if aligned, copy if not)
  let data: NumericTypedArray;
  if (dtypeInfo.bytes === 1 || dataOffset % dtypeInfo.bytes === 0) {
    // Zero-copy: create view directly on the buffer
    data = new dtypeInfo.constructor(buffer, dataOffset, expectedElements);
  } else {
    // Unaligned: must copy (rare, only if header padding is non-standard)
    const slice = buffer.slice(dataOffset, dataOffset + expectedBytes);
    data = new dtypeInfo.constructor(slice, 0, expectedElements);
  }

  return { data, shape, dtype: descr, fortranOrder };
}
