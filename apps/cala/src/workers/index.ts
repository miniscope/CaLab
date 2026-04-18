import type { WorkerLike } from '@calab/cala-runtime';

export function createDecodePreprocessWorker(): WorkerLike {
  return new Worker(new URL('./decode-preprocess.worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as WorkerLike;
}

export function createExtendWorker(): WorkerLike {
  return new Worker(new URL('./extend.worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as WorkerLike;
}

export function createArchiveWorker(): WorkerLike {
  return new Worker(new URL('./archive.worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as WorkerLike;
}
