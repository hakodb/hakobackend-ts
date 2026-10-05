// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { HakoBackendClient } from './client';
import { bindTokenSource, type TokenSource } from './auth';

function source(token: string | null): TokenSource & { emit(): void } {
  const cbs = new Set<() => void>();
  return {
    getToken: async () => token,
    subscribe: (cb: () => void) => {
      cbs.add(cb);
      return () => {
        cbs.delete(cb);
      };
    },
    emit: () => cbs.forEach((cb) => cb()),
  };
}

describe('bindTokenSource', () => {
  it('injects the bearer header on matched URLs and restores fetch on unbind', async () => {
    const client = new HakoBackendClient();
    try {
      const src = source('tok-123');
      const seen: Array<[string, any]> = [];
      const realFetch = window.fetch;
      const stub = (async (input: any, init?: any) => {
        seen.push([String(input), init]);
        return { ok: true, json: async () => ({}) } as any;
      }) as any;
      window.fetch = stub;
      try {
        const unbind = bindTokenSource(client, src);
        src.emit();
        await new Promise((r) => setTimeout(r, 0));
        await fetch('/api/collections/m');
        const headers = new Headers(seen[0][1]?.headers);
        expect(headers.get('Authorization')).toBe('Bearer tok-123');
        await fetch('https://other.example/x');
        expect(seen.length).toBe(2);
        unbind();
        await fetch('/api/collections/m');
        const headersAfter = new Headers(seen[2][1]?.headers);
        expect(headersAfter.get('Authorization')).toBeNull();
        expect(window.fetch).toBe(stub);
        window.fetch = realFetch;
      } finally {
        window.fetch = realFetch;
      }
    } finally {
      client.dispose();
    }
  });

  it('does not clobber an explicit Authorization header', async () => {
    const client = new HakoBackendClient();
    try {
      const src = source('tok-123');
      const realFetch = window.fetch;
      let got: any = null;
      window.fetch = (async (_input: any, init?: any) => {
        got = init;
        return { ok: true, json: async () => ({}) } as any;
      }) as any;
      try {
        const unbind = bindTokenSource(client, src);
        await fetch('/api/collections/m', { headers: { Authorization: 'Bearer explicit' } });
        expect(new Headers(got?.headers).get('Authorization')).toBe('Bearer explicit');
        unbind();
      } finally {
        window.fetch = realFetch;
      }
    } finally {
      client.dispose();
    }
  });

  it('is inert without window (SSR import safety)', async () => {
    const client = new HakoBackendClient();
    try {
      const src = source(null);
      const unbind = bindTokenSource(client, src, { interceptFetch: false, bindSocket: false });
      expect(() => unbind()).not.toThrow();
    } finally {
      client.dispose();
    }
  });
});
