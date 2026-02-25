import { createSignal } from 'solid-js';
import { subscribeAuth } from '@calab/community';
import type { User } from '@calab/community';

const [user, setUser] = createSignal<User | null>(null);
const [authLoading, setAuthLoading] = createSignal<boolean>(true);

subscribeAuth((state) => {
  setUser(state.user);
  setAuthLoading(state.loading);
});

export { user, authLoading };
