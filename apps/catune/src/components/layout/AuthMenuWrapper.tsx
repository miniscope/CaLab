import { AuthMenuWrapper as SharedAuthMenuWrapper } from '@calab/ui';
import { user, authLoading, signInWithEmail, signOut } from '../../lib/community/index.ts';
import { supabaseEnabled } from '@calab/community';

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
