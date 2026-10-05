/**
 * FieldValue sentinels + Timestamp — the `__type__` wire the backend
 * resolves gateway-side (serverTimestamp/increment/arrayUnion/
 * arrayRemove/deleteField). Same shapes Firestore users already write;
 * the backend contract is documented in HTTP_CONTRACT §4.
 */

/** Atomic-operation sentinel factory (mirrors Firestore's FieldValue). */
export class FieldValue {
  static increment(n: number) {
    return { __type: 'increment', n };
  }

  static arrayUnion(...elements: unknown[]) {
    return { __type: 'arrayUnion', elements };
  }

  static arrayRemove(...elements: unknown[]) {
    return { __type: 'arrayRemove', elements };
  }

  static serverTimestamp() {
    return { __type: 'serverTimestamp' };
  }

  static delete() {
    return { __type: 'deleteField' };
  }
}

export const increment = FieldValue.increment;
export const arrayUnion = FieldValue.arrayUnion;
export const arrayRemove = FieldValue.arrayRemove;
export const serverTimestamp = FieldValue.serverTimestamp;

/** Mimics Firestore's deleteField(). */
export function deleteField() {
  return FieldValue.delete();
}

/** Firestore Timestamp shape (seconds + nanoseconds). Serializes to ISO
 * for exact database matches; the backend stamps `_time` itself. */
export class Timestamp {
  constructor(
    public seconds: number,
    public nanoseconds: number,
  ) {}

  static now(): Timestamp {
    const n = Date.now();
    return new Timestamp(Math.floor(n / 1000), (n % 1000) * 1e6);
  }

  static fromDate(date: Date): Timestamp {
    const n = date.getTime();
    return new Timestamp(Math.floor(n / 1000), (n % 1000) * 1e6);
  }

  toDate(): Date {
    return new Date(this.seconds * 1000 + this.nanoseconds / 1e6);
  }

  toMillis(): number {
    return this.seconds * 1000 + this.nanoseconds / 1e6;
  }

  toJSON(): string {
    return this.toDate().toISOString();
  }
}
