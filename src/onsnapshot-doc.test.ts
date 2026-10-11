import { afterEach, describe, expect, it, vi } from 'vitest';
import { HakoBackendClient } from './client';

afterEach(() => {
  vi.unstubAllGlobals();
});

const tick = (): Promise<void> => new Promise<void>((r) => setTimeout(r, 10));

function stubFetch(payload: any) {
  const calls: Array<{ url: string; init: any }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: any) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => payload } as any;
    }),
  );
  return calls;
}

describe('onSnapshot(docRef)', () => {
  it('maps the point query to a live doc snapshot', async () => {
    const client = new HakoBackendClient();
    try {
      stubFetch([{ id: 'a', v: 1 }]);
      (client as any).connection.subscribe = () => () => {};
      const seen: any[] = [];
      const stop = client.onSnapshot(client.doc('m', 'a'), (s) => seen.push(s));
      await tick();
      expect(seen.length).toBeGreaterThan(0);
      expect(seen[0].id).toBe('a');
      expect(seen[0].exists).toBe(true);
      expect(seen[0].data()).toMatchObject({ id: 'a', v: 1 });
      stop();
    } finally {
      client.dispose();
    }
  });

  it('absent doc yields exists:false', async () => {
    const client = new HakoBackendClient();
    try {
      stubFetch([]);
      (client as any).connection.subscribe = () => () => {};
      const seen: any[] = [];
      const stop = client.onSnapshot(client.doc('m', 'ghost'), (s) => seen.push(s));
      await tick();
      expect(seen.length).toBeGreaterThan(0);
      expect(seen[0].id).toBe('ghost');
      expect(seen[0].exists).toBe(false);
      stop();
    } finally {
      client.dispose();
    }
  });
});

describe('slash-path subcollections', () => {
  it('pass through as collection names end to end', async () => {
    const client = new HakoBackendClient();
    try {
      const calls = stubFetch([{ id: 'r1' }]);
      const snap = await client.getDocs(client.collection('posts/p1/revisions'));
      expect(snap.docs.map((d) => d.id)).toEqual(['r1']);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toContain('/api/collections/posts/p1/revisions');
    } finally {
      client.dispose();
    }
  });
});
