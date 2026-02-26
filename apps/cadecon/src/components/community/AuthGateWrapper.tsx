/**
 * CaDecon AuthGate — thin wrapper around the shared AuthGate component.
 */

import { AuthGate as SharedAuthGate } from '@calab/ui';
import { user, authLoading, signInWithEmail, signOut } from '../../lib/community/index.ts';

export function AuthGate() {
  return (
    <SharedAuthGate
      user={user}
      authLoading={authLoading}
      signInWithEmail={signInWithEmail}
      signOut={signOut}
    />
  );
}
