import { AuthCallback as SharedAuthCallback } from '@calab/ui';
import { user, authLoading } from '../../lib/community/index.ts';

export function AuthCallback() {
  return <SharedAuthCallback user={user} loading={authLoading} />;
}
