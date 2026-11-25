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

describe('a GPU factor run (pipelined) waiting for the GPU compressor', () => {
  function pipelined() {
    const fake = (): WorkerLike => ({
      postMessage: vi.fn(),
      terminate: vi.fn(),
      onmessage: null,
      onerror: null,
    });
    const frame = fake();
    const motion = fake();
    const trace = fake();
    const client = createFrameClient(() => frame, {
      pipelined: true,
      makeMotionWorker: () => motion,
      makeTraceWorker: () => trace,
      makeFlatFieldWorker: false,
    });
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
