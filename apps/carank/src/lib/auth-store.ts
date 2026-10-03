// Auth signals come from the shared community store, so CaRank runs a single
// auth subscription (started by initCommunityStore() in index.tsx).
export { user, authLoading } from '@calab/community';
