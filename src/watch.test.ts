import { describe, expect, it, vi } from 'vitest';
import {
  CollectionReference,
  HakoBackendClient,
  HakoBackendQueryDocumentSnapshot,
  Query,
  type QuerySnapshot,
} from './client';
import { watchSnapshot, type SnapshotHost } from './watch';

const tick = (n = 5): Promise<void> => new Promise<void>((r) => {
  const step = (k: number): void => {
    if (k <= 1) r();
    else setTimeout(() => step(k - 1), 0);
  };
  setTimeout(() => step(n), 0);
});

function snap(id: string, data: any) {
  return new HakoBackendQueryDocumentSnapshot(id, data, undefined as any);
}

function queryOf(client: HakoBackendClient, name = 'm') {
  return new Query(new CollectionReference(client, name));
}

/** Fake host: scripted docs, captured change callbacks, counted fetches. */
function fakeHost(docs: any[], opts: { failFirst?: boolean } = {}) {
  let calls = 0;
  let failedOnce = false;
  const cbs: Array<(c: any) => void> = [];
  const listeners: Array<() => void> = [];
  const host: SnapshotHost = {
    getDocs: async () => {
      calls++;
      if (opts.failFirst && !failedOnce) {
        failedOnce = true;
        throw new Error('403');
      }
      return {
        docs: docs.map((d) => snap(d.id, d)),
        docChanges: () => [],
        empty: docs.length === 0,
        forEach(cb: any) {},
      } as unknown as QuerySnapshot<any>;
    },
    onIdentityChange: (cb: () => void) => {
      listeners.push(cb);
      return () => {};
    },
    subscribe: (_t, _o, _g, cb) => {
      cbs.push(cb);
      return () => {};
    },
  };
  return { host, calls: () => calls, cbs, fireIdentity: () => listeners.forEach((cb) => cb()) };
}

describe('watchSnapshot', () => {
  it('delivers the initial snapshot sorted', async () => {
    const client = new HakoBackendClient();
    try {
      const { host } = fakeHost([{ id: 'b', v: 2 }, { id: 'a', v: 1 }]);
      let got: any = null;
      const stop = watchSnapshot(host, queryOf(client), 'm', 'default', (s) => { got = s; });
      await tick();
      expect(got.docs.map((d: any) => d.id)).toEqual(['a', 'b']);
      expect(got.docChanges().map((c: any) => c.type)).toEqual(['added', 'added']);
      stop();
    } finally {
      client.dispose();
    }
  });

  it('applies add/change/remove through the socket lane', async () => {
    const client = new HakoBackendClient();
    try {
      const f = fakeHost([{ id: 'a', v: 1 }]);
      let got: any = null;
      const stop = watchSnapshot(f.host, queryOf(client), 'm', 'default', (s) => { got = s; });
      await tick();
      expect(got.docs.map((d: any) => d.id)).toEqual(['a']);
      f.cbs[0]({ type: 'add', new_val: { id: 'b', v: 2 } });
      await tick();
      expect(got.docs.map((d: any) => d.id)).toEqual(['a', 'b']);
      f.cbs[0]({ type: 'change', new_val: { id: 'a', v: 9 } });
      await tick();
      expect(got.docs.find((d: any) => d.id === 'a').data().v).toBe(9);
      f.cbs[0]({ type: 'remove', old_val: { id: 'b', v: 2 } });
      await tick();
      expect(got.docs.map((d: any) => d.id)).toEqual(['a']);
      stop();
    } finally {
      client.dispose();
    }
  });

  it('dedupes concurrent identical bootstraps into one fetch', async () => {
    const client = new HakoBackendClient();
    try {
      const f = fakeHost([{ id: 'a', v: 1 }]);
      const q = queryOf(client);
      let n = 0;
      const s1 = watchSnapshot(f.host, q, 'm', 'default', () => { n++; });
      const s2 = watchSnapshot(f.host, q, 'm', 'default', () => { n++; });
      await tick();
      expect(f.calls()).toBe(1);
      expect(n).toBe(2);
      s1();
      s2();
    } finally {
      client.dispose();
    }
  });

  it('refetches on identity when the first attempt failed', async () => {
    const client = new HakoBackendClient();
    try {
      const f = fakeHost([{ id: 'a', v: 1 }], { failFirst: true });
      const errors: Error[] = [];
      let got: any = null;
      const stop = watchSnapshot(f.host, queryOf(client), 'm', 'default', (s) => { got = s; }, (e) => { errors.push(e); });
      await tick();
      expect(errors.length).toBe(1);
      expect(got).toBeNull();
      f.fireIdentity();
      await tick(10);
      expect(got.docs.map((d: any) => d.id)).toEqual(['a']);
      expect(f.calls()).toBe(2);
      stop();
    } finally {
      client.dispose();
    }
  });
});
