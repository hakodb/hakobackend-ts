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

describe('soft-delete surface (issue #63)', () => {
  it('deleteDoc is soft by default; force appends ?mode=force', async () => {
    const client = new HakoBackendClient();
    try {
      let calls = stubFetch({ ok: true });
      await client.deleteDoc(client.doc('m', 'a'));
      expect(calls[0].url).not.toContain('mode=force');
      calls = stubFetch({ ok: true });
      await client.deleteDoc(client.doc('m', 'a'), { force: true });
      expect(calls[0].url).toContain('mode=force');
      expect(calls[0].init.method).toBe('DELETE');
    } finally {
      client.dispose();
    }
  });

  it('restoreAvailable / deleteQueue GET with the collection filter', async () => {
    const client = new HakoBackendClient();
    try {
      const record = { col: 'm', id: 'a', deleted_at: 1, scheduled_at: 2, bytes: 3 };
      let calls = stubFetch([record]);
      expect(await client.restoreAvailable('m')).toEqual([record]);
      expect(calls[0].url).toContain('/api/admin/restore-available');
      expect(calls[0].url).toContain('collection=m');
      calls = stubFetch([record]);
      await client.deleteQueue();
      expect(calls[0].url).toContain('/api/admin/delete-queue');
      expect(calls[0].url).not.toContain('collection=');
    } finally {
      client.dispose();
    }
  });

  it('restoreDoc posts collection+id and hydrates the doc', async () => {
    const client = new HakoBackendClient();
    try {
      const calls = stubFetch({ id: 'a', __type__: 'server_ts' });
      await client.restoreDoc('m', 'a');
      expect(calls[0].url).toContain('/api/admin/restore');
      expect(calls[0].init.method).toBe('POST');
      expect(JSON.parse(calls[0].init.body)).toEqual({ collection: 'm', id: 'a' });
    } finally {
      client.dispose();
    }
  });

  it('sweepNow posts and returns the purged count', async () => {
    const client = new HakoBackendClient();
    try {
      const calls = stubFetch({ purged: 7 });
      expect(await client.sweepNow()).toEqual({ purged: 7 });
      expect(calls[0].url).toContain('/api/admin/sweep');
      expect(calls[0].init.method).toBe('POST');
    } finally {
      client.dispose();
    }
  });

  it('backend sections read 404 as null and PUT validates server-side', async () => {
    const client = new HakoBackendClient();
    try {
      let calls = stubFetch({ toml: 'x = 1' });
      expect(await client.getBackendSection('policy')).toEqual({ toml: 'x = 1' });
      expect(calls[0].url).toContain('/api/admin/backend/policy');
      stubFetch(null, false, 404);
      expect(await client.getBackendSection('service')).toBeNull();
      calls = stubFetch({ stored: 'aliases', apply: 'POST /api/admin/reload' });
      await client.putBackendSection('aliases', { decl: [] });
      expect(calls[0].init.method).toBe('PUT');
      expect(JSON.parse(calls[0].init.body)).toEqual({ decl: [] });
      calls = stubFetch({ removed: 'aliases' });
      await client.deleteBackendSection('aliases');
      expect(calls[0].init.method).toBe('DELETE');
      calls = stubFetch({ success: true });
      await client.reload();
      expect(calls[0].url).toContain('/api/admin/reload');
      expect(calls[0].init.method).toBe('POST');
    } finally {
      client.dispose();
    }
  });
});
