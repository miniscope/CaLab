import { describe, expect, it } from 'vitest';
import {
  eventTable,
  neutralizeCell,
  sessionTable,
  tableToCSV,
  tableToJSON,
  toCSV,
} from '../lib/export.ts';
import { event, session } from './helpers.ts';

describe('CSV/JSON export', () => {
  it('quotes commas, quotes and newlines (RFC 4180)', () => {
    expect(toCSV(['a'], [['x,y'], ['say "hi"'], ['l1\nl2']])).toBe(
      'a\n"x,y"\n"say ""hi"""\n"l1\nl2"',
    );
  });

  it.each([
    ['=1+1', "'=1+1"],
    ['+1', "'+1"],
    ['-1+1', "'-1+1"],
    ['@SUM(A1)', "'@SUM(A1)"],
    [' =1+1', "' =1+1"],
    ['-', "'-"],
    ['-x', "'-x"],
    ['@bob', "'@bob"],
    ['\uFF1D1+1', "'\uFF1D1+1"],
    ['\uFF20SUM', "'\uFF20SUM"],
  ])('prefixes formula-like string %j', (input, out) => {
    expect(neutralizeCell(input)).toBe(out);
    expect(toCSV(['a'], [[input]]).split('\n')[1]).toBe(out);
  });

  it('prefixes leading tab, CR and LF (and keeps CSV quoting for the newline cases)', () => {
    expect(toCSV(['a'], [['\tfoo']])).toBe("a\n'\tfoo");
    expect(toCSV(['a'], [['\rfoo']])).toBe('a\n"\'\rfoo"');
    expect(toCSV(['a'], [['\nfoo']])).toBe('a\n"\'\nfoo"');
  });

  it('leaves numbers, safe strings and empties alone', () => {
    expect(toCSV(['a', 'b', 'c', 'd'], [[-5, 'plain', '', null]])).toBe('a,b,c,d\n-5,plain,,');
    expect(neutralizeCell('2026-11-01T12:00:00Z')).toBe('2026-11-01T12:00:00Z');
  });

  it('quotes and prefixes together', () => {
    expect(toCSV(['a'], [['=HYPERLINK("x","y")']])).toBe('a\n"\'=HYPERLINK(""x"",""y"")"');
    expect(toCSV(['a'], [['say "hi", ok\nbye']])).toBe('a\n"say ""hi"", ok\nbye"');
  });

  it('applies to every exported string column, including a tester-like tag in event data', () => {
    const s = session({ app_version: '-1', region: '=x' });
    const csv = tableToCSV(sessionTable([s]));
    expect(csv).toContain("'-1");
    expect(csv).toContain("'=x");
    const ev = tableToCSV(eventTable([event(s.id, 'tester_tag', { tag: '@bob' })], [s]));
    expect(ev).toContain('@bob'); // inside JSON text starting with {, so no prefix needed
  });

  it('does not prefix JSON export values', () => {
    const s = session({ region: '=x' });
    expect(JSON.parse(tableToJSON(sessionTable([s])))[0].region).toBe('=x');
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
