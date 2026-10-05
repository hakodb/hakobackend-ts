import { describe, expect, it } from 'vitest';
import {
  FieldValue,
  Timestamp,
  arrayRemove,
  arrayUnion,
  deleteField,
  increment,
  serverTimestamp,
} from './fieldvalue';

/** The `__type__` wire shapes the backend resolves gateway-side. */
describe('FieldValue', () => {
  it('emits the documented sentinel shapes', () => {
    expect(serverTimestamp()).toEqual({ __type: 'serverTimestamp' });
    expect(increment(2)).toEqual({ __type: 'increment', n: 2 });
    expect(arrayUnion('a', 'b')).toEqual({ __type: 'arrayUnion', elements: ['a', 'b'] });
    expect(arrayRemove('a')).toEqual({ __type: 'arrayRemove', elements: ['a'] });
    expect(deleteField()).toEqual({ __type: 'deleteField' });
    // Bound consts are the same factories.
    expect(FieldValue.serverTimestamp()).toEqual(serverTimestamp());
  });
});

describe('Timestamp', () => {
  it('round-trips through ISO for exact database matches', () => {
    const t = Timestamp.fromDate(new Date('2026-08-15T00:00:00.000Z'));
    expect(t.seconds).toBe(Math.floor(Date.parse('2026-08-15T00:00:00.000Z') / 1000));
    expect(t.toDate().toISOString()).toBe('2026-08-15T00:00:00.000Z');
    expect(t.toJSON()).toBe('2026-08-15T00:00:00.000Z');
    expect(JSON.stringify({ at: t })).toBe('{"at":"2026-08-15T00:00:00.000Z"}');
    expect(Timestamp.now().toMillis()).toBeLessThanOrEqual(Date.now());
  });
});
