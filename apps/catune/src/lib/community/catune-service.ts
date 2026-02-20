// CaTune community CRUD service — one-liner using the shared factory.

import { createSubmissionService } from '@calab/community';
import type { CatuneSubmission } from './types.ts';

const service = createSubmissionService<CatuneSubmission>('catune_submissions');

export const submitParameters = service.submit;
export const fetchSubmissions = service.fetch;
export const deleteSubmission = service.delete;
