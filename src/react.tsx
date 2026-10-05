/**
 * React bindings (separate entry — core stays framework-free).
 *
 * Thin wrappers over the watch engine: the collection/query semantics,
 * ordering and identity-refetch behavior are tested once in watch.test.ts;
 * these hooks only bind them to component lifecycles. App-specific concerns
 * (error buses, toasts, converters-as-defaults) stay in the app.
 *
 * Import from `@hakodb/backend/react`. React is a peer dependency.
 */

import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { HakoBackendClient, type DocumentData, type QuerySnapshot } from './client';
import { CollectionReference, DocumentReference, Query } from './client';
import { watchSnapshot } from './watch';

const ClientContext = createContext<HakoBackendClient | null>(null);

/** Provide the client (create once, e.g. `useMemo(() => new HakoBackendClient(), [])`). */
export function HakoProvider({
  client,
  children,
}: {
  client: HakoBackendClient;
  children: React.ReactNode;
}) {
  return <ClientContext.Provider value={client}>{children}</ClientContext.Provider>;
}

/** The client from the nearest provider. */
export function useHakoClient(): HakoBackendClient {
  const client = useContext(ClientContext);
  if (!client) throw new Error('useHakoClient must be used inside <HakoProvider>');
  return client;
}

export interface SnapshotState<T> {
  data: (T & { id: string })[] | null;
  loading: boolean;
  error: Error | null;
  snapshot: QuerySnapshot<T> | null;
}

function toRows<T>(snapshot: QuerySnapshot<T> | null): (T & { id: string })[] | null {
  if (!snapshot) return null;
  return snapshot.docs.map((d) => ({ ...d.data(), id: d.id }) as T & { id: string });
}

/** Live collection/query snapshot. Null query unsubscribes (loading false). */
export function useCollection<T extends DocumentData>(
  query: Query<T> | CollectionReference<T> | null,
  client?: HakoBackendClient,
): SnapshotState<T> {
  const viaProvider = useHakoClientSafe();
  const c = client ?? viaProvider;
  const [snapshot, setSnapshot] = useState<QuerySnapshot<T> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!c || !query) {
      setSnapshot(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const queryObj = query instanceof CollectionReference ? new Query<T>(query) : query;
    const stop = watchSnapshot(
      c.host(),
      queryObj,
      queryObj.colRef.name,
      queryObj.resolvedDb(c),
      (snap) => {
        setSnapshot(snap);
        setLoading(false);
      },
      (err) => setError(err),
    );
    return () => stop();
    // ponytail: query object identity is the subscription key (same rule
    // as the apps: new constraints object = new subscription). eslint
    // exhaustive-deps would want queryObj fields; identity is intended.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c, query]);

  const data = useMemo(() => toRows(snapshot), [snapshot]);
  return { data, loading, error, snapshot };
}

/** Live single-document snapshot (implemented as a limit-1 filtered query, like the apps). */
export function useDoc<T extends DocumentData>(
  ref: DocumentReference<T> | null,
  client?: HakoBackendClient,
): { data: (T & { id: string }) | null; loading: boolean; error: Error | null } {
  const viaProvider = useHakoClientSafe();
  const c = client ?? viaProvider;
  const [state, setState] = useState<{
    data: (T & { id: string }) | null;
    loading: boolean;
    error: Error | null;
  }>({ data: null, loading: true, error: null });

  useEffect(() => {
    if (!c || !ref) {
      setState({ data: null, loading: false, error: null });
      return;
    }
    // ponytail: reuse useCollection's engine via a direct watchSnapshot
    // (not by composing hooks — one subscription, no double fetch).
    const colRef = new CollectionReference<T>(c, ref.collectionName, null, ref.db);
    const q = new Query<T>(colRef);
    const stop = watchSnapshot(
      c.host(),
      q,
      ref.collectionName,
      ref.db ?? c.defaultDatabase,
      (snap) => {
        const hit = snap.docs.find((d) => d.id === ref.id);
        setState({
          data: hit ? ({ ...hit.data(), id: hit.id } as T & { id: string }) : null,
          loading: false,
          error: null,
        });
      },
      (err) => setState({ data: null, loading: false, error: err }),
    );
    return () => stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c, ref]);

  return state;
}

/** useContext without the throw (for the optional-client pattern above). */
function useHakoClientSafe(): HakoBackendClient | undefined {
  return useContext(ClientContext) ?? undefined;
}
