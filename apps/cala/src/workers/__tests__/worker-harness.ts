import type { WorkerInbound, WorkerOutbound } from '@calab/cala-runtime';

export interface WorkerSelf {
  postMessage(msg: WorkerOutbound): void;
  onmessage: ((ev: MessageEvent<WorkerInbound>) => void) | null;
}

export interface WorkerHarness {
  self: WorkerSelf;
  posted: WorkerOutbound[];
  deliver(msg: WorkerInbound): Promise<void>;
}

export function createWorkerHarness(): WorkerHarness {
  const posted: WorkerOutbound[] = [];
  const self: WorkerSelf = {
    postMessage: (msg) => {
      posted.push(msg);
    },
    onmessage: null,
  };
  return {
    self,
    posted,
    async deliver(msg) {
      const handler = self.onmessage;
      if (!handler) throw new Error('onmessage not installed');
      handler({ data: msg } as MessageEvent<WorkerInbound>);
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}
