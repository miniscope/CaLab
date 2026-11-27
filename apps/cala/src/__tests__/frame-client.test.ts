// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { frameClientOn, inertWorker } from './fake-workers.ts';

function setup() {
  const worker = inertWorker();
  return { worker, client: frameClientOn(worker) };
}

describe('frame client failure handling', () => {
  it('rejects pending and future requests after a worker crash', async () => {
    const { worker, client } = setup();
    const read = expect(client.readFrame(0)).rejects.toThrow('worker failed');
    const step = expect(client.stepPipeline()).rejects.toThrow('worker failed');
    worker.onerror!.call({} as Worker, { message: 'worker failed' } as ErrorEvent);
    await Promise.all([read, step]);
    await expect(client.open([])).rejects.toThrow('worker failed');
    // `link`, the read and the step.
    expect(worker.postMessage).toHaveBeenCalledTimes(3);
    client.dispose();
  });

  it('rejects pending and future requests after disposal', async () => {
    const { worker, client } = setup();
    const read = expect(client.readFrame(0)).rejects.toThrow('disposed');
    client.dispose();
    await read;
    await expect(client.readFrame(1)).rejects.toThrow('disposed');
    // `link` and the read.
    expect(worker.postMessage).toHaveBeenCalledTimes(2);
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
        data: { type: 'frames', id: 3, start: 1, count: 1, pixels: new Uint8Array([42]) },
      } as MessageEvent,
    );
    await expect(next).resolves.toEqual(new Uint8Array([42]));
    client.dispose();
  });
});

describe('a GPU factor run waiting for the GPU compressor', () => {
  function pipelined() {
    const trace = inertWorker();
    const client = frameClientOn(inertWorker(), { trace });
    const released = () =>
      vi.mocked(trace.postMessage).mock.calls.filter(([m]) => m.type === 'release-compress').length;
    return { client, trace, released };
  }

  it('is released at once on Stop, a new run and a new source; other runs send nothing', () => {
    const { client, released } = pipelined();
    void client.startPipeline({}, { session: 1, discover: true, compress: true }).catch(() => {});
    void client.stopPipeline().catch(() => {});
    expect(released()).toBe(0); // not a GPU run
    void client
      .startPipeline({}, { session: 2, discover: true, compress: true, compressGpu: true })
      .catch(() => {});
    expect(released()).toBe(0);
    void client.stopPipeline().catch(() => {});
    expect(released()).toBe(1);
    void client.stopPipeline().catch(() => {});
    expect(released()).toBe(1); // once per run
    void client
      .startPipeline({}, { session: 3, discover: true, compress: true, compressGpu: true })
      .catch(() => {});
    void client
      .startPipeline({}, { session: 4, discover: true, compress: true, compressGpu: true })
      .catch(() => {});
    expect(released()).toBe(2); // a new run without a Stop
    void client.open([]).catch(() => {});
    expect(released()).toBe(3); // a new source
    client.dispose();
  });
});
