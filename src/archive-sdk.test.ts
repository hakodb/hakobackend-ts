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

describe('archive SDK (issue #21)', () => {
  it('relocateDocs posts src/dst/ids and returns moved+missing', async () => {
    const client = new HakoBackendClient();
    try {
      const calls = stubFetch({ moved: ['a'], missing: ['g'] });
      const res = await client.relocateDocs('m', 'm2', ['a', 'g']);
      expect(res).toEqual({ moved: ['a'], missing: ['g'] });
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toContain('/api/relocate');
      expect(calls[0].init.method).toBe('POST');
      expect(JSON.parse(calls[0].init.body)).toEqual({ src: 'm', dst: 'm2', ids: ['a', 'g'] });
    } finally {
      client.dispose();
    }
  });

  it('load/unload/unloaded hit the residency endpoints', async () => {
    const client = new HakoBackendClient();
    try {
      let calls = stubFetch({ ok: true });
      await client.loadCollection('arc');
      expect(calls[0].url).toContain('/api/collections/load');
      calls = stubFetch({ ok: true });
      await client.unloadCollection('arc');
      expect(calls[0].url).toContain('/api/collections/unload');
      calls = stubFetch(['arc']);
      expect(await client.unloadedCollections()).toEqual(['arc']);
      expect(calls[0].url).toContain('/api/collections/unloaded');
    } finally {
      client.dispose();
    }
  });

  it('getField reads the field path and maps 404 to undefined', async () => {
    const client = new HakoBackendClient();
    try {
      const calls = stubFetch(5);
      expect(await client.getField(client.doc('m', 'a'), 'n.x')).toBe(5);
      expect(calls[0].url).toContain('/api/collections/m/a/n.x');
      stubFetch(null, false, 404);
      expect(await client.getField(client.doc('m', 'a'), 'nope')).toBeUndefined();
    } finally {
      client.dispose();
    }
  });
});
