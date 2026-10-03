// Admin auth + role signals.

import { createSignal } from 'solid-js';
// user/authLoading come from the shared community store, so the admin app runs
// a single auth subscription (started by initCommunityStore() in index.tsx).
import { user, authLoading, supabaseEnabled } from '@calab/community';
import type { AdminView, DateRange } from './types.ts';

const [activeView, setActiveView] = createSignal<AdminView>('overview');

const today = new Date();
const thirtyDaysAgo = new Date(today);
thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

const [dateRange, setDateRange] = createSignal<DateRange>({
  start: thirtyDaysAgo.toISOString().slice(0, 10),
  end: today.toISOString().slice(0, 10),
});

function isAdmin(): boolean {
  const metadata = user()?.app_metadata;
  return metadata?.role === 'admin';
}

export {
  user,
  authLoading,
  isAdmin,
  supabaseEnabled,
  activeView,
  setActiveView,
  dateRange,
  setDateRange,
};
