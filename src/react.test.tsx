// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { HakoBackendClient } from './client';
import { HakoProvider, useCollection, useDoc } from './react';
import type { QuerySnapshot } from './client';
import { HakoBackendQueryDocumentSnapshot } from './client';

function snap(id: string, data: any) {
  return new HakoBackendQueryDocumentSnapshot(id, data, undefined as any);
}

function clientWithDocs(docs: any[]) {
  const client = new HakoBackendClient();
  const getDocs = async () => ({
    docs: docs.map((d) => snap(d.id, d)),
    docChanges: () => [],
    empty: docs.length === 0,
    forEach() {},
  }) as unknown as QuerySnapshot<any>;
  // ponytail: stub the network boundary, not the engine — the hooks
  // bind lifecycles; data flow is already proven in watch.test.ts.
  client.getDocs = getDocs as any;
  return client;
}

describe('useCollection', () => {
  it('renders rows then stops loading', async () => {
    const client = clientWithDocs([{ id: 'a', v: 1 }]);
    try {
      const View = () => {
        const { data, loading } = useCollection(client.collection('m'));
        if (loading) return <div>loading</div>;
        return <div>{data!.map((d: any) => d.id).join(',')}</div>;
      };
      render(
        <HakoProvider client={client}>
          <View />
        </HakoProvider>,
      );
      expect(screen.getByText('loading')).toBeTruthy();
      await waitFor(() => screen.getByText('a'));
    } finally {
      client.dispose();
    }
  });

  it('null query unsubscribes (loading false, no fetch)', async () => {
    const client = clientWithDocs([{ id: 'a', v: 1 }]);
    try {
      let fetched = false;
      client.getDocs = (async () => {
        fetched = true;
        return { docs: [], docChanges: () => [], empty: true, forEach() {} } as any;
      }) as any;
      const View = () => {
        const { data, loading } = useCollection(null);
        return <div>{loading ? 'loading' : `rows:${data?.length ?? 'null'}`}</div>;
      };
      render(
        <HakoProvider client={client}>
          <View />
        </HakoProvider>,
      );
      await waitFor(() => screen.getByText('rows:null'));
      expect(fetched).toBe(false);
    } finally {
      client.dispose();
    }
  });
});

describe('useDoc', () => {
  it('resolves the matching doc by id', async () => {
    const client = clientWithDocs([
      { id: 'a', v: 1 },
      { id: 'b', v: 2 },
    ]);
    try {
      const View = () => {
        const { data, loading } = useDoc(client.doc('m', 'b'));
        if (loading) return <div>loading</div>;
        return <div>{data ? `${data.id}:${(data as any).v}` : 'missing'}</div>;
      };
      render(
        <HakoProvider client={client}>
          <View />
        </HakoProvider>,
      );
      await waitFor(() => screen.getByText('b:2'));
    } finally {
      client.dispose();
    }
  });
});
