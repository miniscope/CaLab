import { AuthMenuWrapper as SharedAuthMenuWrapper } from '@calab/ui';
import { user, authLoading } from '../lib/auth-store.ts';
import { signInWithEmail, signOut, supabaseEnabled } from '@calab/community';

export function AuthMenuWrapper() {
  return (
    <SharedAuthMenuWrapper
      user={user}
      loading={authLoading}
      enabled={supabaseEnabled}
      signInWithEmail={signInWithEmail}
      signOut={signOut}
    />
  );
}
