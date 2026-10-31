export type { GpuFistaParams } from './types.ts';
export {
  createGpuFista,
  requestGpuDevice,
  estimateGpuBytes,
  maxCellsPerGroup,
} from './gpu-fista.ts';
export type { GpuFista, GpuSolutions } from './gpu-fista.ts';
export {
  clampTauRise,
  buildKernel,
  kernelDcGain,
  computeImpulsePeak,
  computeBandedLipschitz,
  computeBandedParams,
} from './banded-params.ts';
export type { BandedParams } from './banded-params.ts';
export { referenceFista } from './fista-reference.ts';
export { relL2, maxAbsDiff, BLOCK, WG, K } from './scan-reference.ts';
export { fistaShaderSource } from './shaders/fista-wgsl.ts';
