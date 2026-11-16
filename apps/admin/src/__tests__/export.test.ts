import { describe, expect, it } from 'vitest';
import { eventTable, sessionTable, tableToCSV, tableToJSON, toCSV } from '../lib/export.ts';
import { event, session } from './helpers.ts';

describe('CSV/JSON export', () => {
  it('quotes commas, quotes and newlines (RFC 4180)', () => {
    expect(toCSV(['a'], [['x,y'], ['say "hi"'], ['l1\nl2']])).toBe(
      'a\n"x,y"\n"say ""hi"""\n"l1\nl2"',
    );
  });

  it('defuses spreadsheet formulas', () => {
    expect(toCSV(['a'], [['=SUM(A1)'], ['@cmd'], ['+1']])).toBe("a\n'=SUM(A1)\n'@cmd\n'+1");
  });

  it('never exports the full user id', () => {
    const s = session({ user_id: 'aaaaaaaa-1111-2222-3333-444444444444' });
    const csv = tableToCSV(sessionTable([s]));
    expect(csv).not.toContain('aaaaaaaa-1111');
    expect(csv.split('\n')[0]).toContain('browser');
  });

  it('exports events with their app and JSON data', () => {
    const s = session({ app_name: 'cala' });
    const t = eventTable(
      [event(s.id, 'run_failed', { stage: 'discover' }), event('orphan', 'x')],
      [s],
    );
    expect(t.rows[0][2]).toBe('cala');
    expect(t.rows[1][2]).toBe('');
    expect(JSON.parse(tableToJSON(t))[0].data).toBe('{"stage":"discover"}');
  });

  it('has a documented column for every exported column', () => {
    const t = sessionTable([session()]);
    expect(t.rows[0]).toHaveLength(t.columns.length);
  });
});
