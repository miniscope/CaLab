import { createRoot } from 'solid-js';
import { describe, expect, it } from 'vitest';
import { createViewerStore } from '../lib/viewer-store.ts';

/** A live stream's address never becomes the recording label (it goes into exports). */
describe('viewer store live label', () => {
  const open = async (live: { url: string; name?: string }) => {
    const client = {
      dispose: () => {},
      openLive: async () => ({ frameCount: Infinity, width: 4, height: 4, live, files: [] }),
    };
    return createRoot(async (dispose) => {
      const store = createViewerStore(client as never);
      await store.openLive(live.url);
      const label = store.label();
      dispose();
      return label;
    });
  };

  it('uses the stream name, or a neutral text for an unnamed one', async () => {
    expect(await open({ url: 'ws://10.0.0.5:5555', name: 'rig 2' })).toBe('rig 2');
    expect(await open({ url: 'ws://10.0.0.5:5555' })).toBe('(live stream)');
  });
});
