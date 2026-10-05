import { describe, expect, it } from 'vitest';
import { hydrateTimestamps } from './hydrate';

/**
 * Regression: the hydrator used to replace every ISO date string with a
 * `{ toDate, toMillis, toISOString }` object. Consumers that treat timestamps
 * as strings (`Date.parse`, `new Date(...)`, lexicographic sorts) then broke —
 * most visibly an activity feed dropped every entry, showing "no activity at
 * all". Date fields must stay parseable ISO strings.
 */
describe('hydrateTimestamps', () => {
  it('keeps ISO date strings as parseable strings', () => {
    const doc = { createdAt: '2026-08-15T00:44:03.503Z', title: 'Test' };
    const out = hydrateTimestamps(doc);
    expect(typeof out.createdAt).toBe('string');
    expect(Number.isNaN(Date.parse(out.createdAt))).toBe(false);
    expect(new Date(out.createdAt).getFullYear()).toBe(2026);
  });

  it('keeps nested ISO date strings parseable', () => {
    const doc = {
      timeline: { review: { at: '2026-04-28T15:44:02.033Z', index: 3 } },
    };
    const out = hydrateTimestamps(doc);
    expect(typeof out.timeline.review.at).toBe('string');
    expect(Number.isNaN(Date.parse(out.timeline.review.at))).toBe(false);
  });

  it('keeps Date instances as Date instances', () => {
    const d = new Date('2026-08-15T00:00:00.000Z');
    const out = hydrateTimestamps({ at: d });
    expect(out.at).toBeInstanceOf(Date);
    expect(Number.isNaN(out.at.getTime())).toBe(false);
  });

  it('keeps arrays of docs intact', () => {
    const rows = [
      { createdAt: '2026-08-15T00:44:02.359Z' },
      { createdAt: '2026-07-01T00:00:00.000Z' },
    ];
    const out = hydrateTimestamps(rows);
    expect(out).toHaveLength(2);
    for (const row of out) {
      expect(typeof row.createdAt).toBe('string');
      expect(Number.isNaN(Date.parse(row.createdAt))).toBe(false);
    }
  });
});
