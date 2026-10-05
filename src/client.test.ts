import { describe, expect, it } from 'vitest';
import { HakoBackendClient, Query, buildApiUrl } from './client';

const BASE = 'https://api.example.test:3000';

describe('buildApiUrl', () => {
  it('leaves single-db URLs byte-identical (absent/default)', () => {
    expect(buildApiUrl(BASE, '/api/collections/m').toString()).toBe(
      'https://api.example.test:3000/api/collections/m',
    );
    expect(buildApiUrl(BASE, '/api/collections/m', 'default').toString()).toBe(
      'https://api.example.test:3000/api/collections/m',
    );
  });

  it('appends ?db= for named databases', () => {
    expect(buildApiUrl(BASE, '/api/collections/m', 'app1').toString()).toBe(
      'https://api.example.test:3000/api/collections/m?db=app1',
    );
  });

  it('coexists with ?options= as a sibling param', () => {
    const url = buildApiUrl(BASE, '/api/collections/m', 'app1');
    url.searchParams.append('options', '{"limit":50}');
    expect(url.searchParams.get('db')).toBe('app1');
    expect(url.searchParams.get('options')).toBe('{"limit":50}');
  });
});

describe('database resolution', () => {
  it('defaults to default, ref db wins, useDatabase repoints', () => {
    const client = new HakoBackendClient();
    try {
      expect(client.defaultDatabase).toBe('default');
      const ref = client.doc('m', 'a');
      expect(ref.db).toBeUndefined();
      const scoped = client.doc('m', 'a', 'app1');
      expect(scoped.db).toBe('app1');
      const q = new Query(client.collection('m', 'app2'));
      expect(q.resolvedDb(client)).toBe('app2');
      client.useDatabase('app1');
      expect(client.doc('m', 'a').db).toBeUndefined();
    } finally {
      client.dispose();
    }
  });
});
