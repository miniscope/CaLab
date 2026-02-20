import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BaseSubmission } from '../types.ts';

// Mock the supabase module before importing submission-service
vi.mock('../supabase.ts', () => ({
  getSupabase: vi.fn(),
  supabaseEnabled: true,
}));

import { createSubmissionService } from '../submission-service.ts';
import { getSupabase } from '../supabase.ts';

const mockGetSupabase = vi.mocked(getSupabase);

interface TestSubmission extends BaseSubmission {
  score: number;
}

describe('createSubmissionService', () => {
  const service = createSubmissionService<TestSubmission>('test_submissions');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('submit', () => {
    it('throws when Supabase is not configured', async () => {
      mockGetSupabase.mockResolvedValue(null);
      await expect(service.submit({ score: 5 } as TestSubmission)).rejects.toThrow(
        'Community features not configured',
      );
    });

    it('throws when not authenticated', async () => {
      mockGetSupabase.mockResolvedValue({
        auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
      } as never);
      await expect(service.submit({ score: 5 } as TestSubmission)).rejects.toThrow(
        'Not authenticated',
      );
    });

    it('inserts payload with user_id and returns created row', async () => {
      const mockRow = { id: '1', score: 5, user_id: 'u1' };
      const mockInsert = vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: mockRow, error: null }),
        }),
      });
      mockGetSupabase.mockResolvedValue({
        auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'u1' } } }) },
        from: vi.fn().mockReturnValue({ insert: mockInsert }),
      } as never);

      const result = await service.submit({ score: 5 } as TestSubmission);
      expect(result).toEqual(mockRow);
      expect(mockInsert).toHaveBeenCalledWith({ score: 5, user_id: 'u1' });
    });
  });

  describe('fetch', () => {
    it('throws when Supabase is not configured', async () => {
      mockGetSupabase.mockResolvedValue(null);
      await expect(service.fetch()).rejects.toThrow('Community features not configured');
    });

    it('returns all rows when no filters', async () => {
      const rows = [{ id: '1', score: 5 }];
      const selectFn = vi.fn().mockReturnValue({ data: rows, error: null });
      mockGetSupabase.mockResolvedValue({
        from: vi.fn().mockReturnValue({ select: selectFn }),
      } as never);

      const result = await service.fetch();
      expect(result).toEqual(rows);
    });

    it('applies base filters (indicator, species, brainRegion)', async () => {
      const rows = [{ id: '1' }];
      // Mock query chain: from().select().eq().eq().eq() -> { data, error }
      const queryObj = {
        eq: vi.fn(),
        then: undefined as unknown,
        data: rows,
        error: null,
      };
      // Each .eq() call returns the same chainable object
      queryObj.eq = vi.fn().mockReturnValue(queryObj);
      const selectFn = vi.fn().mockReturnValue(queryObj);
      mockGetSupabase.mockResolvedValue({
        from: vi.fn().mockReturnValue({ select: selectFn }),
      } as never);

      const result = await service.fetch({
        indicator: 'GCaMP6f',
        species: 'mouse',
        brainRegion: 'cortex',
      });
      expect(queryObj.eq).toHaveBeenCalledWith('indicator', 'GCaMP6f');
      expect(queryObj.eq).toHaveBeenCalledWith('species', 'mouse');
      expect(queryObj.eq).toHaveBeenCalledWith('brain_region', 'cortex');
      expect(result).toEqual(rows);
    });
  });

  describe('delete', () => {
    it('throws when Supabase is not configured', async () => {
      mockGetSupabase.mockResolvedValue(null);
      await expect(service.delete('some-id')).rejects.toThrow('Community features not configured');
    });

    it('deletes by id', async () => {
      const eqFn = vi.fn().mockResolvedValue({ error: null });
      const deleteFn = vi.fn().mockReturnValue({ eq: eqFn });
      mockGetSupabase.mockResolvedValue({
        from: vi.fn().mockReturnValue({ delete: deleteFn }),
      } as never);

      await service.delete('abc-123');
      expect(eqFn).toHaveBeenCalledWith('id', 'abc-123');
    });
  });
});
