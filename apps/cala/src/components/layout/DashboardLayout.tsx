import { type JSX } from 'solid-js';
import { FrameQuad } from '../frame/FrameQuad.tsx';
import { VitalsBar } from '../vitals/VitalsBar.tsx';
import { EventFeed } from '../events/EventFeed.tsx';

/**
 * Running-state layout (design §12): vitals bar along the top, the
 * 4-canvas frame panel (Phase 7 task 7) in the primary area, and the
 * event feed as a right-hand side panel. Each cell is independently
 * scrollable so a long event log never pushes the sparklines
 * off-screen.
 */
export function DashboardLayout(): JSX.Element {
  return (
    <div class="cala-dashboard">
      <div class="cala-dashboard__vitals">
        <VitalsBar />
      </div>
      <div class="cala-dashboard__frame">
        <FrameQuad />
      </div>
      <div class="cala-dashboard__events">
        <EventFeed />
      </div>
    </div>
  );
}
