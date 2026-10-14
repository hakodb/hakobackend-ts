import { afterEach, describe, expect, it, vi } from 'vitest';
import { HakoBackendClient } from './client';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(payload: any, ok = true, status = 200) {
  const calls: Array<{ url: string; init: any }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: any) => {
      calls.push({ url, init });
      return { ok, status, json: async () => payload } as any;
    }),
  );
  return calls;
}

describe('traverse SDK', () => {
  it('traverseIndexCreate posts collection', async () => {
    const client = new HakoBackendClient();
    try {
      const calls = stubFetch({ success: true, index: { name: 'traverse(g)' } });
      const res = await client.traverseIndexCreate('g');
      expect(res).toEqual({ success: true, index: { name: 'traverse(g)' } });
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toContain('/api/traverse-index');
      expect(calls[0].init.method).toBe('POST');
      expect(JSON.parse(calls[0].init.body)).toEqual({ collection: 'g' });
    } finally {
      client.dispose();
    }
  });

  it('traverseSearch posts walk params and returns hits in order', async () => {
    const client = new HakoBackendClient();
    try {
      const payload = [
        { collection: 'g', id: 'b', depth: 1, doc: { id: 'b' } },
        { collection: 'g', id: 'c', depth: 2, doc: { id: 'c' } },
      ];
      const calls = stubFetch(payload);
      const res = await client.traverseSearch('g', 'a', 'outgoing', null, 10, 100);
      expect(res.map((h) => h.id)).toEqual(['b', 'c']);
      expect(res[0].depth).toBe(1);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toContain('/api/traverse-search/g');
      expect(calls[0].init.method).toBe('POST');
      expect(JSON.parse(calls[0].init.body)).toEqual({ start_id: 'a', direction: 'outgoing', edge: null, max_depth: 10, k: 100, via: null, weight: null });
    } finally {
      client.dispose();
    }
  });

  it('traverseSearch posts via/weight and returns cost-ordered hits', async () => {
    const client = new HakoBackendClient();
    try {
      const payload = [
        { collection: 'n', id: 'b', depth: 1, cost: 1.0, doc: { id: 'b' } },
        { collection: 'n', id: 'c', depth: 2, cost: 2.0, doc: { id: 'c' } },
      ];
      const calls = stubFetch(payload);
      const res = await client.traverseSearch('n', 'a', 'outgoing', null, 10, 100, 'rel', 'w');
      expect(res.map((h) => h.id)).toEqual(['b', 'c']);
      expect(res[1].cost).toBeCloseTo(2.0, 4);
      expect(JSON.parse(calls[0].init.body)).toEqual({ start_id: 'a', direction: 'outgoing', edge: null, max_depth: 10, k: 100, via: 'rel', weight: 'w' });
    } finally {
      client.dispose();
    }
  });

  it('edgeIndexCreate posts collection', async () => {
    const client = new HakoBackendClient();
    try {
      const calls = stubFetch({ success: true, index: { name: 'edge(rel)' } });
      const res = await client.edgeIndexCreate('rel');
      expect(res).toEqual({ success: true, index: { name: 'edge(rel)' } });
      expect(calls[0].url).toContain('/api/edge-index');
      expect(JSON.parse(calls[0].init.body)).toEqual({ collection: 'rel' });
    } finally {
      client.dispose();
    }
  });
});
