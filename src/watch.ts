/**
 * Snapshot watch engine (framework-free).
 *
 * `HakoBackendClient.onSnapshot` delegates here with itself as the host;
 * tests inject a fake host (no network). The engine owns: initial
 * bootstrap, change application with ordering, batching, identity
 * refetch, and bootstrap dedup (concurrent identical subscriptions
 * share one in-flight fetch — keyed by db|collection|options, deleted
 * on settle so nothing leaks).
 */

import type {
  CollectionReference,
  DocumentChange,
  DocumentData,
  Protocol,
  Query,
  QueryDocumentSnapshot,
  QuerySnapshot,
} from './client';
import { DocumentReference, HakoBackendQueryDocumentSnapshot } from './client';

/** The client capabilities a live subscription needs (test seam). */
export interface SnapshotHost {
  getDocs<T>(q: Query<T> | CollectionReference<T>): Promise<QuerySnapshot<T>>;
  onIdentityChange(listener: () => void): () => void;
  subscribe(
    table: string,
    options: Protocol.QueryOptions | null,
    isGroup: boolean,
    callback: (change: Protocol.ChangeEvent) => void,
    db?: string,
  ): () => void;
}

// In-flight bootstrap fetches keyed by `db|collection|options` fingerprint.
// Same-page subscriptions are one identity (token changes refetch via the
// identity listener below), so sharing the promise is sound; entries are
// deleted on settle.
const inflight = new Map<string, Promise<unknown>>();

export function compareDocs(a: any, b: any, orderBy: Protocol.OrderBy[]) {
  const criteria = orderBy.length > 0 ? orderBy : [{ field: 'id', direction: 'asc' } as Protocol.OrderBy];

  for (const { field, direction } of criteria) {
    const valA = field.split('.').reduce((acc, part) => acc && acc[part], a);
    const valB = field.split('.').reduce((acc, part) => acc && acc[part], b);

    if (valA < valB) return direction === 'asc' ? -1 : 1;
    if (valA > valB) return direction === 'asc' ? 1 : -1;
  }
  return 0;
}

export function findInsertionIndex(array: any[], item: any, orderBy: Protocol.OrderBy[]): number {
  let low = 0;
  let high = array.length;

  while (low < high) {
    const mid = (low + high) >>> 1;
    if (compareDocs(array[mid], item, orderBy) < 0) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

export function watchSnapshot<T = DocumentData>(
  host: SnapshotHost,
  queryObj: Query<T>,
  colName: string,
  db: string,
  onNext: (snapshot: QuerySnapshot<T>) => void,
  onError?: (error: Error) => void,
): () => void {
  const options = queryObj.buildOptions();

  let currentDocs: T[] = [];
  let isInitial = true;
  let loadSucceeded = false;
  let pendingChanges: DocumentChange<T>[] = [];
  let scheduleTimeoutId: any = null;

  const flushBatch = () => {
    if (pendingChanges.length === 0) return;

    const deduplicatedChangesMap = new Map<string, DocumentChange<T>>();
    pendingChanges.forEach((change) => {
      deduplicatedChangesMap.set(change.doc.id, change);
    });

    const consolidatedChanges = Array.from(deduplicatedChangesMap.values());
    const docsList = currentDocs.map((d: any) => {
      const docRef = new DocumentReference<T>(queryObj.colRef.client, queryObj.colRef.name, d.id, queryObj.colRef.db);
      return new HakoBackendQueryDocumentSnapshot<T>(d.id, d, docRef);
    });

    onNext({
      docs: docsList,
      docChanges: () => consolidatedChanges,
      empty: docsList.length === 0,
      forEach(callback: (doc: QueryDocumentSnapshot<T>) => void, thisArg?: any) {
        docsList.forEach(callback, thisArg);
      }
    });

    pendingChanges = [];
    scheduleTimeoutId = null;
  };

  const unsubscribe = host.subscribe(colName, options, queryObj.isGroup, (change) => {
    const { type, old_val, new_val } = change;
    const docId = (new_val?.id || old_val?.id);
    const oldIndex = currentDocs.findIndex((d: any) => (d as any).id === docId);

    let docChange: DocumentChange<T> | null = null;
    const docRef = new DocumentReference<T>(queryObj.colRef.client, queryObj.colRef.name, docId, queryObj.colRef.db);

    if (type === 'add' || (type === 'change' && oldIndex === -1)) {
      const insertIndex = findInsertionIndex(currentDocs, new_val, options.orderBy);
      currentDocs.splice(insertIndex, 0, new_val);

      docChange = {
        type: 'added',
        doc: new HakoBackendQueryDocumentSnapshot<T>(docId, new_val, docRef),
        oldIndex: -1,
        newIndex: insertIndex
      };
    }
    else if (type === 'remove' || (type === 'change' && new_val === null)) {
      if (oldIndex !== -1) {
        const removedDoc = currentDocs.splice(oldIndex, 1)[0];
        docChange = {
          type: 'removed',
          doc: new HakoBackendQueryDocumentSnapshot<T>(docId, removedDoc, docRef),
          oldIndex,
          newIndex: -1
        };
      }
    }
    else if (type === 'change') {
      if (oldIndex !== -1) {
        currentDocs.splice(oldIndex, 1);
        const newIndex = findInsertionIndex(currentDocs, new_val, options.orderBy);
        currentDocs.splice(newIndex, 0, new_val);

        docChange = {
          type: 'modified',
          doc: new HakoBackendQueryDocumentSnapshot<T>(docId, new_val, docRef),
          oldIndex,
          newIndex
        };
      }
    }

    if (!isInitial && docChange) {
      pendingChanges.push(docChange);

      if (!scheduleTimeoutId) {
        const scheduler = typeof requestAnimationFrame !== 'undefined'
          ? requestAnimationFrame
          : (cb: any) => setTimeout(cb, 0);

        scheduleTimeoutId = scheduler(flushBatch);
      }
    }
  }, db);

  const loadInitial = () => {
    const key = `${db}|${colName}|${JSON.stringify(options)}`;
    let p = inflight.get(key) as Promise<QuerySnapshot<T>> | undefined;
    if (!p) {
      p = host.getDocs<T>(queryObj);
      inflight.set(key, p);
      // ponytail: delete on settle via a side branch (not by chaining
      // the shared promise — that would serialize waiters behind each
      // other's processing). Each waiter chains independently below.
      void p.then(
        () => { if (inflight.get(key) === p) inflight.delete(key); },
        () => { if (inflight.get(key) === p) inflight.delete(key); },
      );
    }
    return p.then(snapshot => {
      loadSucceeded = true;
      currentDocs = snapshot.docs.map(d => d.data());
      currentDocs.sort((a, b) => compareDocs(a, b, options.orderBy));
      isInitial = false;

      const docsList = currentDocs.map((d: any) => {
        const docRef = new DocumentReference<T>(queryObj.colRef.client, queryObj.colRef.name, d.id, queryObj.colRef.db);
        return new HakoBackendQueryDocumentSnapshot<T>(d.id, d, docRef);
      });

      onNext({
        docs: docsList,
        docChanges: () => snapshot.docs.map((d, i) => ({
          type: 'added',
          doc: d,
          oldIndex: -1,
          newIndex: i
        })),
        empty: docsList.length === 0,
        forEach(callback: (doc: QueryDocumentSnapshot<T>) => void, thisArg?: any) {
          docsList.forEach(callback, thisArg);
        }
      });
    }).catch(err => {
      if (onError) onError(err);
    });
  };

  loadInitial();

  // If the initial fetch fired before the token was ready (e.g.
  // right after a page refresh), it failed with 403 and left the snapshot
  // empty. Refetch once the identity becomes available — but only if the
  // first attempt didn't already succeed (avoids duplicate fetches on
  // periodic token refreshes).
  const refetchOnIdentity = () => {
    if (!loadSucceeded) void loadInitial();
  };
  const stopListeningIdentity = host.onIdentityChange(refetchOnIdentity);

  return () => {
    stopListeningIdentity();
    if (scheduleTimeoutId) {
      if (typeof cancelAnimationFrame !== 'undefined') {
        cancelAnimationFrame(scheduleTimeoutId);
      } else {
        clearTimeout(scheduleTimeoutId);
      }
    }
    unsubscribe();
  };
}
