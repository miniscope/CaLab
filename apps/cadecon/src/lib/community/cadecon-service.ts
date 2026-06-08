// CaDecon community CRUD service — one-liner using the shared factory.

import { createSubmissionService } from '@calab/community';
import type { CadeconSubmission } from './types.ts';

// Reads go through the PII-free public view (migration 010); writes/deletes
// target the base table under owner-scoped RLS.
const service = createSubmissionService<CadeconSubmission>(
  'cadecon_submissions',
  'cadecon_submissions_public',
);

export const submitParameters = service.submit;
export const fetchSubmissions = service.fetch;
export const deleteSubmission = service.delete;
