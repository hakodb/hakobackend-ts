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

describe('vector SDK', () => {
  it('vectorIndexCreate posts collection/field/dim/metric', async () => {
    const client = new HakoBackendClient();
    try {
      const calls = stubFetch({ success: true, index: { name: 'vector(emb)' } });
      const res = await client.vectorIndexCreate('pts', 'emb', 2);
      expect(res).toEqual({ success: true, index: { name: 'vector(emb)' } });
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toContain('/api/vector-index');
      expect(calls[0].init.method).toBe('POST');
      expect(JSON.parse(calls[0].init.body)).toEqual({ collection: 'pts', field: 'emb', dim: 2, metric: 'cosine' });
    } finally {
      client.dispose();
    }
  });

  it('vectorSearch posts field/query/k and returns hits in order', async () => {
    const client = new HakoBackendClient();
    try {
      const payload = [
        { id: 'c', score: 0.0513, doc: { id: 'c', emb: [1, 1] } },
        { id: 'a', score: 0.1055, doc: { id: 'a', emb: [1, 0] } },
      ];
      const calls = stubFetch(payload);
      const res = await client.vectorSearch('pts', 'emb', Float32Array.from([1, 0.5]), 2);
      expect(res.map((h) => h.id)).toEqual(['c', 'a']);
      expect(res[0].score).toBeCloseTo(0.0513, 4);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toContain('/api/vector-search/pts');
      expect(calls[0].init.method).toBe('POST');
      // Float32Array flattens to a plain JSON array on the wire.
      expect(JSON.parse(calls[0].init.body)).toEqual({ field: 'emb', query: [1, 0.5], k: 2, metric: 'cosine' });
    } finally {
      client.dispose();
    }
  });
});
