// Admin auth + role signals.
// Checks user.app_metadata.role === 'admin' after sign-in.

import { createSignal } from 'solid-js';
import { subscribeAuth, supabaseEnabled } from '@calab/community';
import type { User } from '@calab/community';
import type { AdminView, DateRange } from './types.ts';

const [user, setUser] = createSignal<User | null>(null);
const [authLoading, setAuthLoading] = createSignal(true);
const [activeView, setActiveView] = createSignal<AdminView>('overview');

const today = new Date();
const thirtyDaysAgo = new Date(today);
thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

const [dateRange, setDateRange] = createSignal<DateRange>({
  start: thirtyDaysAgo.toISOString().slice(0, 10),
  end: today.toISOString().slice(0, 10),
});

subscribeAuth((state) => {
  setUser(state.user);
  setAuthLoading(state.loading);
});

function isAdmin(): boolean {
  const u = user();
  if (!u) return false;
  return (u as unknown as { app_metadata?: { role?: string } }).app_metadata?.role === 'admin';
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
