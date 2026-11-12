import { afterEach, describe, expect, it, vi } from 'vitest';

/** A worker that answers every request with `reply(req)`. */
function fakeWorker(reply: (req: { op: string }) => Record<string, unknown>) {
  return class {
    onmessage: ((e: MessageEvent) => void) | null = null;
    onerror: ((e: ErrorEvent) => void) | null = null;
    postMessage(req: { id: number; op: string }) {
      queueMicrotask(() =>
        this.onmessage?.({ data: { id: req.id, ...reply(req) } } as MessageEvent),
      );
    }
  };
}

function stubBrowser(reply: (req: { op: string }) => Record<string, unknown>) {
  vi.stubGlobal('Worker', fakeWorker(reply));
  vi.stubGlobal('navigator', { storage: { getDirectory: () => Promise.resolve({}) } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('opfsUsable', () => {
  it('is false when the API is missing', async () => {
    vi.stubGlobal('navigator', {});
    const { opfsUsable } = await import('../lib/opfs-writer.ts');
    expect(await opfsUsable()).toBe(false);
  });

  it('is false when the browser exposes OPFS but a test write fails (private or ephemeral storage)', async () => {
    stubBrowser(() => ({
      ok: false,
      name: 'UnknownError',
      message: 'The operation failed for an unknown transient reason',
    }));
    const { opfsUsable } = await import('../lib/opfs-writer.ts');
    expect(await opfsUsable()).toBe(false);
  });

  it('is true when the test write works, and asks once', async () => {
    const ops: string[] = [];
    stubBrowser((req) => {
      ops.push(req.op);
      return { ok: true };
    });
    const { opfsUsable } = await import('../lib/opfs-writer.ts');
    expect(await opfsUsable()).toBe(true);
    expect(await opfsUsable()).toBe(true);
    expect(ops).toEqual(['probe']);
  });

  it('makes createTraceFile keep the traces in memory when the test write fails', async () => {
    stubBrowser(() => ({ ok: false, name: 'UnknownError', message: 'nope' }));
    const { createTraceFile } = await import('../lib/trace-file.ts');
    const f = await createTraceFile(10, 4);
    expect(f.kind).toBe('memory');
    await f.dispose();
  });
});
