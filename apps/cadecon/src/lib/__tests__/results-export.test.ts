import { describe, it, expect } from 'vitest';
import { FIELD_DESCRIPTIONS } from '../results-export.ts';
import { buildCaDeconResultsPayload } from '../export-utils.ts';

/**
 * FIELD_DESCRIPTIONS lives in results-export.ts while the payload it documents
 * is built in export-utils.ts, so nothing but this test stops a newly added
 * field from shipping undocumented (or a renamed one from leaving a stale
 * description behind). The key set is state-independent, so an empty store is
 * enough to enumerate it.
 */
const SIBLING_FILE_KEYS = ['activity']; // documents activity.<ext>, not a results.json key

describe('FIELD_DESCRIPTIONS', () => {
  describe('happy path', () => {
    it('documents every results.json key and nothing else', () => {
      const payloadKeys = Object.keys(buildCaDeconResultsPayload()).sort();
      const documented = Object.keys(FIELD_DESCRIPTIONS)
        .filter((k) => !SIBLING_FILE_KEYS.includes(k))
        .sort();
      expect(documented).toEqual(payloadKeys);
    });

    it('documents the sibling activity array', () => {
      for (const key of SIBLING_FILE_KEYS) {
        expect(FIELD_DESCRIPTIONS[key]).toBeTruthy();
      }
    });
  });
});
