import { describe, expect, it } from 'vitest';
import { FramePreviewSetting } from '../lib/frame-preview-setting.ts';

describe('FramePreviewSetting', () => {
  it('holds the asked view within a run and clears it at every run start', () => {
    const s = new FramePreviewSetting();
    s.startRun(false);
    s.set('output');
    expect(s.current).toBe('output');
    s.startRun(false);
    expect(s.current).toBeNull();
    s.set('raw');
    expect(s.current).toBe('raw');
  });

  it('never has a view during a replay, whatever is asked', () => {
    const s = new FramePreviewSetting();
    s.startRun(false);
    s.set('output');
    s.startRun(true);
    expect(s.current).toBeNull();
    s.set('output');
    expect(s.current).toBeNull();
    s.startRun(false);
    s.set('output');
    expect(s.current).toBe('output');
  });
});
