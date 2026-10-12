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
    expect(serverTimestamp()).toEqual({ __type__: 'serverTimestamp' });
    expect(increment(2)).toEqual({ __type__: 'increment', n: 2 });
    expect(arrayUnion('a', 'b')).toEqual({ __type__: 'arrayUnion', elements: ['a', 'b'] });
    expect(arrayRemove('a')).toEqual({ __type__: 'arrayRemove', elements: ['a'] });
    expect(deleteField()).toEqual({ __type__: 'deleteField' });
    // Bound consts are the same factories.
    expect(FieldValue.serverTimestamp()).toEqual(serverTimestamp());
  });

  it('uses the exact key the gateway checks (atomics.rs is_sentinel)', () => {
    // Regression for the single-underscore bug: sentinels with `__type`
    // stored as plain data, silently. Every factory must key `__type__`.
    for (const s of [serverTimestamp(), increment(1), arrayUnion(1), arrayRemove(1), deleteField()] as any[]) {
      expect(Object.keys(s)).toContain('__type__');
      expect(Object.keys(s)).not.toContain('__type');
    }
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
