import { AuthCallback as SharedAuthCallback } from '@calab/community-ui';
import { user, authLoading } from '../lib/auth-store.ts';

export function AuthCallback() {
  return <SharedAuthCallback user={user} loading={authLoading} />;
}
