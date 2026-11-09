// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createFrameClient, type WorkerLike } from '../lib/frame-client.ts';

function setup() {
  const worker: WorkerLike = {
    postMessage: vi.fn(),
    terminate: vi.fn(),
    onmessage: null,
    onerror: null,
  };
  return { worker, client: createFrameClient(() => worker) };
}

describe('frame client failure handling', () => {
  it('rejects pending and future requests after a worker crash', async () => {
    const { worker, client } = setup();
    const read = expect(client.readFrame(0)).rejects.toThrow('worker failed');
    const step = expect(client.stepPipeline()).rejects.toThrow('worker failed');
    worker.onerror!.call({} as Worker, { message: 'worker failed' } as ErrorEvent);
    await Promise.all([read, step]);
    await expect(client.open([])).rejects.toThrow('worker failed');
    expect(worker.postMessage).toHaveBeenCalledTimes(2);
    client.dispose();
  });

  it('rejects pending and future requests after disposal', async () => {
    const { worker, client } = setup();
    const read = expect(client.readFrame(0)).rejects.toThrow('disposed');
    client.dispose();
    await read;
    await expect(client.readFrame(1)).rejects.toThrow('disposed');
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('recovers from a request-specific postMessage failure', async () => {
    const { worker, client } = setup();
    vi.mocked(worker.postMessage).mockImplementationOnce(() => {
      throw new Error('cannot transfer');
    });
    await expect(client.readFrame(0)).rejects.toThrow('cannot transfer');
    const next = client.readFrame(1);
    worker.onmessage!.call(
      {} as Worker,
      {
        data: { type: 'frames', id: 2, start: 1, count: 1, pixels: new Uint8Array([42]) },
      } as MessageEvent,
    );
    await expect(next).resolves.toEqual(new Uint8Array([42]));
    client.dispose();
  });
});
