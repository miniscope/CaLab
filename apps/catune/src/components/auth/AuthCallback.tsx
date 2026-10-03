import { AuthCallback as SharedAuthCallback } from '@calab/community-ui';
import { user, authLoading } from '../../lib/community/index.ts';

export function AuthCallback() {
  return <SharedAuthCallback user={user} loading={authLoading} />;
}
