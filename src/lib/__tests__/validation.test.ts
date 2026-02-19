import { describe, it, expect } from 'vitest';
import { validateTraceData } from '../validation.ts';

describe('validateTraceData', () => {
  describe('happy path', () => {
    it('returns valid result for clean 2D float64 data', () => {
      const data = new Float64Array([1.0, 2.0, 3.0, 4.0, 5.0, 6.0]);
      const shape = [2, 3]; // 2 cells, 3 timepoints

      const result = validateTraceData(data, shape);

      expect(result.isValid).toBe(true);
      expect(result.warnings).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
      expect(result.stats.min).toBe(1.0);
      expect(result.stats.max).toBe(6.0);
      expect(result.stats.mean).toBeCloseTo(3.5);
      expect(result.stats.nanCount).toBe(0);
      expect(result.stats.infCount).toBe(0);
      expect(result.stats.negativeCount).toBe(0);
      expect(result.stats.totalElements).toBe(6);
    });

    it('returns valid result for clean float32 data', () => {
      const data = new Float32Array([10, 20, 30, 40]);
      const shape = [2, 2];

      const result = validateTraceData(data, shape);

      expect(result.isValid).toBe(true);
      expect(result.stats.min).toBe(10);
      expect(result.stats.max).toBe(40);
    });
  });

  describe('warnings', () => {
    it('warns about NaN values with count and percentage', () => {
      const data = new Float64Array([1.0, NaN, 3.0, NaN, 5.0, 6.0]);
      const shape = [2, 3];

      const result = validateTraceData(data, shape);

      expect(result.isValid).toBe(true);
      const nanWarning = result.warnings.find((w) => w.type === 'nan_values');
      expect(nanWarning).toBeDefined();
      expect(nanWarning!.count).toBe(2);
      expect(nanWarning!.message).toContain('2');
      expect(nanWarning!.message).toContain('33.3%');
    });

    it('warns about Inf values with count', () => {
      const data = new Float64Array([1.0, Infinity, 3.0, -Infinity, 5.0, 6.0]);
      const shape = [2, 3];

      const result = validateTraceData(data, shape);

      expect(result.isValid).toBe(true);
      const infWarning = result.warnings.find((w) => w.type === 'inf_values');
      expect(infWarning).toBeDefined();
      expect(infWarning!.count).toBe(2);
    });

    it('warns about suspicious shape (rows > cols)', () => {
      const data = new Float64Array(12); // 4 rows x 3 cols
      data.fill(1.0);
      const shape = [4, 3];

      const result = validateTraceData(data, shape);

      expect(result.isValid).toBe(true);
      const shapeWarning = result.warnings.find((w) => w.type === 'suspicious_shape');
      expect(shapeWarning).toBeDefined();
      expect(shapeWarning!.message).toContain('4');
      expect(shapeWarning!.message).toContain('3');
    });

    it('does not warn about suspicious shape when cols >= rows', () => {
      const data = new Float64Array(12);
      data.fill(1.0);
      const shape = [3, 4]; // 3 rows x 4 cols, normal

      const result = validateTraceData(data, shape);

      const shapeWarning = result.warnings.find((w) => w.type === 'suspicious_shape');
      expect(shapeWarning).toBeUndefined();
    });
  });

  describe('errors', () => {
    it('reports error for all-NaN data', () => {
      const data = new Float64Array([NaN, NaN, NaN, NaN]);
      const shape = [2, 2];

      const result = validateTraceData(data, shape);

      expect(result.isValid).toBe(false);
      const nanError = result.errors.find((e) => e.type === 'all_nan');
      expect(nanError).toBeDefined();
    });

    it('reports error for non-2D shape', () => {
      const data = new Float64Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      const shape = [10]; // 1D

      const result = validateTraceData(data, shape);

      expect(result.isValid).toBe(false);
      const dimError = result.errors.find((e) => e.type === 'not_2d');
      expect(dimError).toBeDefined();
      expect(dimError!.message).toContain('1D');
    });

    it('reports error for 3D shape', () => {
      const data = new Float64Array(24);
      const shape = [2, 3, 4]; // 3D

      const result = validateTraceData(data, shape);

      expect(result.isValid).toBe(false);
      const dimError = result.errors.find((e) => e.type === 'not_2d');
      expect(dimError).toBeDefined();
      expect(dimError!.message).toContain('3D');
    });

    it('reports error for empty array', () => {
      const data = new Float64Array(0);
      const shape = [0, 0];

      const result = validateTraceData(data, shape);

      expect(result.isValid).toBe(false);
      const emptyError = result.errors.find((e) => e.type === 'empty_array');
      expect(emptyError).toBeDefined();
    });
  });

  describe('stats computation', () => {
    it('computes correct stats excluding NaN and Inf', () => {
      const data = new Float64Array([1.0, NaN, 3.0, Infinity, -2.0, 4.0]);
      const shape = [2, 3];

      const result = validateTraceData(data, shape);

      expect(result.stats.min).toBe(-2.0);
      expect(result.stats.max).toBe(4.0);
      // mean of [1, 3, -2, 4] = 6/4 = 1.5
      expect(result.stats.mean).toBeCloseTo(1.5);
      expect(result.stats.nanCount).toBe(1);
      expect(result.stats.infCount).toBe(1);
      expect(result.stats.negativeCount).toBe(1);
      expect(result.stats.totalElements).toBe(6);
    });

    it('counts negative values correctly (deltaF/F can be negative)', () => {
      const data = new Float64Array([-1, -2, 3, 4, -5, 6]);
      const shape = [2, 3];

      const result = validateTraceData(data, shape);

      expect(result.stats.negativeCount).toBe(3);
      // Negative values should NOT produce a warning (deltaF/F can be negative)
      const negWarning = result.warnings.find((w) => w.type === 'negative_values');
      expect(negWarning).toBeUndefined();
    });

    it('handles data with only NaN and Inf (all invalid, but not all NaN)', () => {
      const data = new Float64Array([NaN, Infinity, NaN, -Infinity]);
      const shape = [2, 2];

      const result = validateTraceData(data, shape);

      // Not all NaN (some are Inf), so it should be valid but with warnings
      expect(result.stats.nanCount).toBe(2);
      expect(result.stats.infCount).toBe(2);
      expect(result.stats.mean).toBeNaN(); // no valid values for mean
    });
  });
});
