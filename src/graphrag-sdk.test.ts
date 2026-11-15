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

describe('graphrag SDK', () => {
  it('hybridSearch posts fields/query/k/rrf_k', async () => {
    const client = new HakoBackendClient();
    try {
      const calls = stubFetch([{ id: 'd1', score: 0.03, doc: { id: 'd1' } }]);
      const res = await client.hybridSearch('docs', 'title', 'red', 'emb', [1, 0], 5, 0);
      expect(res).toHaveLength(1);
      expect(calls[0].url).toContain('/api/hybrid-search/docs');
      expect(JSON.parse(calls[0].init.body)).toEqual({
        text_field: 'title',
        text_query: 'red',
        vec_field: 'emb',
        query: [1, 0],
        k: 5,
        rrf_k: 0
      });
    } finally {
      client.dispose();
    }
  });

  it('graphPagerank posts seeds/damping/top', async () => {
    const client = new HakoBackendClient();
    try {
      const calls = stubFetch([{ node: 'g/b', score: 0.4 }]);
      const res = await client.graphPagerank('g', ['g/a'], { damping: 0.9, top: 5 });
      expect(res[0].node).toBe('g/b');
      expect(calls[0].url).toContain('/api/graph-pagerank/g');
      expect(JSON.parse(calls[0].init.body)).toEqual({
        seeds: ['g/a'],
        direction: 'outgoing',
        edge: null,
        via: null,
        damping: 0.9,
        top: 5
      });
    } finally {
      client.dispose();
    }
  });

  it('subgraph posts seed_id/max_depth', async () => {
    const client = new HakoBackendClient();
    try {
      const calls = stubFetch({ nodes: [], edges: [] });
      const res = await client.subgraph('g', 'a', { maxDepth: 2 });
      expect(res).toEqual({ nodes: [], edges: [] });
      expect(calls[0].url).toContain('/api/subgraph/g');
      expect(JSON.parse(calls[0].init.body)).toEqual({
        seed_id: 'a',
        direction: 'outgoing',
        edge: null,
        via: null,
        max_depth: 2
      });
    } finally {
      client.dispose();
    }
  });

  it('vectorIndexCreate forwards binary_stage1', async () => {
    const client = new HakoBackendClient();
    try {
      const calls = stubFetch({ success: true });
      await client.vectorIndexCreate('pts', 'emb', 2, 'cosine', undefined, true);
      expect(JSON.parse(calls[0].init.body)).toEqual({
        collection: 'pts',
        field: 'emb',
        dim: 2,
        metric: 'cosine',
        binary_stage1: true
      });
    } finally {
      client.dispose();
    }
  });
});
