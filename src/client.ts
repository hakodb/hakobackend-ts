// HakoBackend TypeScript client — port of the legacy rethink-firestore
// `ui/src/lib/client.ts`, adapted to the hakobackend wire protocol:
// native WebSocket `/ws` (no socket.io), PATCH-based merge, `{error}`
// failure bodies, tenant/provisioning helpers, local-auth helpers.
//
// Surface (classes, methods, constraints, snapshots) is intentionally
// identical so consumer code migrates by changing imports.

import { hydrateTimestamps } from "./hydrate";

const BACKEND_URL = (() => {
  // Vite apps: VITE_BACKEND_URL is inlined at build time.
  const viteUrl = (import.meta as any)?.env?.VITE_BACKEND_URL as string | undefined;
  if (viteUrl) return viteUrl.replace(/\/+$/, "");
  // Next.js apps: NEXT_PUBLIC_* is inlined at build time (guarded so Vite
  // bundles never reference `process` at runtime).
  const nextUrl = typeof process !== "undefined" ? (process.env?.NEXT_PUBLIC_BACKEND_URL as string | undefined) : undefined;
  if (nextUrl) return nextUrl.replace(/\/+$/, "");
  return "";
})();

const WS_URL = BACKEND_URL.replace(/^http/, "ws");

/**
 * Protocol definitions for backend communication
 */
export namespace Protocol {
  export type Op = '==' | '!=' | '>' | '<' | '>=' | '<=' | 'array-contains' | 'array-contains-any' | 'in';

  export interface QueryFilter {
    field: string;
    op: Op;
    value: any;
  }

  export interface OrderBy {
    field: string;
    direction: 'asc' | 'desc';
  }

  export interface QueryOptions {
    filters: QueryFilter[];
    fields: string[];
    orderBy: OrderBy[];
    limit?: number;
    startAt?: any;
    startAfter?: any;
    endAt?: any;
    endBefore?: any;
  }

  export interface ChangeEvent {
    type: 'add' | 'change' | 'remove';
    old_val?: any;
    new_val?: any;
  }

  export interface BatchOperation {
    type: 'set' | 'update' | 'delete' | 'add' | 'get';
    collection: string;
    id?: string;
    data?: any;
    options?: { merge?: boolean };
  }
}

/**
 * TypeScript-first interfaces for Document Data
 */
export type DocumentData = Record<string, any>;

export interface FirestoreDataConverter<T> {
  toFirestore(modelObject: T): DocumentData;
  fromFirestore(snapshot: QueryDocumentSnapshot<DocumentData>): T;
}

export interface DocumentSnapshot<T = DocumentData> {
  id: string;
  exists: boolean;
  ref: DocumentReference<T>;
  data(): T | undefined;
}

export interface QueryDocumentSnapshot<T = DocumentData> extends DocumentSnapshot<T> {
  data(): T;
}

export interface DocumentChange<T = DocumentData> {
  type: 'added' | 'modified' | 'removed';
  doc: QueryDocumentSnapshot<T>;
  oldIndex: number;  // -1 if added
  newIndex: number;  // -1 if removed
}

export interface QuerySnapshot<T = DocumentData> {
  docs: QueryDocumentSnapshot<T>[];
  docChanges(): DocumentChange<T>[];
  empty: boolean;
  forEach(callback: (result: QueryDocumentSnapshot<T>) => void, thisArg?: any): void;
}

/**
 * Extensible Query Constraint System
 */
export interface QueryConstraint {
  readonly type: string;
  apply(options: Protocol.QueryOptions): void;
}

export class WhereConstraint implements QueryConstraint {
  readonly type = 'where';
  constructor(private field: string, private op: Protocol.Op, private value: any) {}
  apply(options: Protocol.QueryOptions) {
    options.filters.push({ field: this.field, op: this.op, value: this.value });
  }
}

export class OrderByConstraint implements QueryConstraint {
  readonly type = 'orderBy';
  constructor(private field: string, private direction: 'asc' | 'desc') {}
  apply(options: Protocol.QueryOptions) {
    options.orderBy.push({ field: this.field, direction: this.direction });
  }
}

export class LimitConstraint implements QueryConstraint {
  readonly type = 'limit';
  constructor(private n: number) {}
  apply(options: Protocol.QueryOptions) {
    options.limit = this.n;
  }
}

export class SelectConstraint implements QueryConstraint {
  readonly type = 'select';
  constructor(private fields: string[]) {}
  apply(options: Protocol.QueryOptions) {
    options.fields.push(...this.fields);
  }
}

export class CursorConstraint implements QueryConstraint {
  readonly type: 'startAt' | 'startAfter' | 'endAt' | 'endBefore';
  constructor(type: 'startAt' | 'startAfter' | 'endAt' | 'endBefore', private value: any) {
    this.type = type;
  }
  apply(options: Protocol.QueryOptions) {
    options[this.type] = this.value;
  }
}

/**
 * Native-WebSocket connection manager (replaces socket.io).
 * Manual reconnect with backoff; resubscribes on open; per-key events.
 */
class ConnectionManager {
  private socket: WebSocket | null = null;
  private subscriptions: Map<string, { tableName: string; options: Protocol.QueryOptions | null; isGroup: boolean }> = new Map();
  private listeners: Map<string, Set<(change: Protocol.ChangeEvent) => void>> = new Map();
  private identity: { token: string } | null = null;
  private isConnected: boolean = false;
  private reconnectDelay: number = 1000;
  private closed: boolean = false;

  constructor() {
    this.connect();
  }

  private connect() {
    if (this.closed || typeof WebSocket === 'undefined') return;
    const url = this.identity?.token
      ? `${WS_URL}/ws?token=${encodeURIComponent(this.identity.token)}`
      : `${WS_URL}/ws`;
    const ws = new WebSocket(url);
    this.socket = ws;

    ws.onopen = () => {
      console.log('[HakoBackend] Connected to backend');
      this.isConnected = true;
      this.reconnectDelay = 1000;
      this.resubscribe();
    };

    ws.onmessage = (ev) => {
      let msg: any;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
      } catch {
        return;
      }
      if (msg.type === 'change' && typeof msg.key === 'string') {
        const set = this.listeners.get(msg.key);
        if (!set) return;
        // Server shape {kind, doc} -> legacy {type, old_val, new_val}.
        const change: Protocol.ChangeEvent = msg.kind === 'remove'
          ? { type: 'remove', old_val: hydrateTimestamps(msg.doc), new_val: undefined }
          : { type: msg.kind, old_val: undefined, new_val: hydrateTimestamps(msg.doc) };
        set.forEach((cb) => cb(change));
      }
    };

    ws.onclose = () => {
      this.isConnected = false;
      if (this.closed) return;
      console.warn(`[HakoBackend] Disconnected, retrying in ${this.reconnectDelay}ms`);
      setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10000);
    };

    ws.onerror = () => {
      // onclose follows and drives the backoff.
    };
  }

  /**
   * Update the auth identity used for socket subscriptions. Re-emits every
   * active subscription so authorized feeds get established.
   */
  setIdentity(identity: { token: string } | null) {
    this.identity = identity;
    if (this.isConnected) {
      this.resubscribe();
    }
  }

  close() {
    this.closed = true;
    this.socket?.close();
  }

  private send(msg: any) {
    if (this.isConnected && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(msg));
    }
  }

  private resubscribe() {
    if (this.subscriptions.size > 0) {
      console.log(`[HakoBackend] Resubscribing to ${this.subscriptions.size} subscriptions`);
      this.subscriptions.forEach((subscription, subscriptionKey) => {
        this.send({
          type: 'subscribe',
          key: subscriptionKey,
          collection: subscription.tableName,
          options: subscription.options || {},
          group: subscription.isGroup,
          token: this.identity?.token,
        });
      });
    }
  }

  subscribe(table: string, options: Protocol.QueryOptions | null, isGroup: boolean, callback: (change: Protocol.ChangeEvent) => void) {
    // Two live queries on the same collection with different filters must get
    // distinct server-side subscriptions, so include a stable options fingerprint
    // in the key. The server treats this key as opaque.
    const subscriptionKey = `${isGroup ? 'group:' : ''}${table}|${JSON.stringify(options || {})}`;
    this.subscriptions.set(subscriptionKey, { tableName: table, options, isGroup });
    let set = this.listeners.get(subscriptionKey);
    if (!set) {
      set = new Set();
      this.listeners.set(subscriptionKey, set);
    }
    set.add(callback);
    this.send({
      type: 'subscribe',
      key: subscriptionKey,
      collection: table,
      options: options || {},
      group: isGroup,
      token: this.identity?.token,
    });

    return () => {
      set!.delete(callback);
      if (set!.size === 0) {
        this.listeners.delete(subscriptionKey);
        this.subscriptions.delete(subscriptionKey);
        this.send({ type: 'unsubscribe', key: subscriptionKey });
      }
    };
  }
}

function compareDocs(a: any, b: any, orderBy: Protocol.OrderBy[]) {
  const criteria = orderBy.length > 0 ? orderBy : [{ field: 'id', direction: 'asc' } as Protocol.OrderBy];

  for (const { field, direction } of criteria) {
    const valA = field.split('.').reduce((acc, part) => acc && acc[part], a);
    const valB = field.split('.').reduce((acc, part) => acc && acc[part], b);

    if (valA < valB) return direction === 'asc' ? -1 : 1;
    if (valA > valB) return direction === 'asc' ? 1 : -1;
  }
  return 0;
}

function findInsertionIndex(array: any[], item: any, orderBy: Protocol.OrderBy[]): number {
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

async function throwForStatus(response: Response, fallback: string): Promise<never> {
  let detail = fallback;
  try {
    const body = await response.json();
    // hakobackend failure shape: {error, code?}.
    if (body && typeof body.error === 'string') detail = body.error;
  } catch {
    // non-JSON body: keep the fallback.
  }
  if (response.status === 403) throw new Error(`Permission denied by security rules (${detail})`);
  throw new Error(`${fallback} (HTTP ${response.status}: ${detail})`);
}

/**
 * HakoBackend client (HTTP + native WebSocket).
 */
export class HakoBackendClient {
  private connection: ConnectionManager;
  private identity: { token: string } | null = null;
  private identityListeners: Array<() => void> = [];

  constructor() {
    this.connection = new ConnectionManager();
  }

  /** Release the socket (apps with HMR / tests). */
  dispose() {
    this.connection.close();
  }

  setIdentity(id: { token: string } | null) {
    this.identity = id;
    // Propagate to the socket layer so pending (previously anonymous)
    // subscriptions are re-emitted with the fresh token.
    this.connection.setIdentity(id);
    // Notify active snapshots so they can refetch their initial data, which
    // may have failed with 403 before the token was ready.
    if (id?.token) {
      this.identityListeners.forEach((listener) => listener());
    }
  }

  onIdentityChange(listener: () => void): () => void {
    this.identityListeners.push(listener);
    return () => {
      this.identityListeners = this.identityListeners.filter((l) => l !== listener);
    };
  }

  private get headers(): HeadersInit {
    const h: HeadersInit = { "Content-Type": "application/json" };
    if (this.identity?.token) {
      h["Authorization"] = `Bearer ${this.identity.token}`;
    }
    return h;
  }

  collection<T = DocumentData>(name: string) {
    return new CollectionReference<T>(this, name);
  }

  collectionGroup<T = DocumentData>(name: string) {
    return new Query<T>(new CollectionReference<T>(this, name), [], true);
  }

  doc<T = DocumentData>(collectionName: string, id: string) {
    return new DocumentReference<T>(this, collectionName, id);
  }

  async getDocs<T = DocumentData>(q: Query<T> | CollectionReference<T>): Promise<QuerySnapshot<T>> {
    const queryObj = q instanceof CollectionReference ? new Query<T>(q) : q;
    const options = queryObj.buildOptions();
    const baseUrl = queryObj.isGroup ? `/api/collectionGroup/${queryObj.colRef.name}` : `/api/collections/${queryObj.colRef.name}`;

    const url = new URL(baseUrl, BACKEND_URL);
    url.searchParams.append('options', JSON.stringify(options));

    const response = await fetch(url.toString(), {
      headers: this.headers
    });
    if (!response.ok) {
      await throwForStatus(response, `Failed to fetch collection ${queryObj.colRef.name}`);
    }
    const rawData = await response.json();
    const hydratedData = hydrateTimestamps(rawData);

    const docsList = hydratedData.map((item: any) => {
      const docRef = new DocumentReference<T>(queryObj.colRef.client, queryObj.colRef.name, item.id);
      return new HakoBackendQueryDocumentSnapshot<T>(item.id, item, docRef);
    });

    return {
      docs: docsList,
      docChanges: () => [],
      empty: docsList.length === 0,
      forEach(callback: (doc: QueryDocumentSnapshot<T>) => void, thisArg?: any) {
        docsList.forEach(callback, thisArg);
      }
    };
  }

  async getDoc<T = DocumentData>(docRef: DocumentReference<T>): Promise<DocumentSnapshot<T>> {
    const url = new URL(`/api/collections/${docRef.collectionName}/${docRef.id}`, BACKEND_URL);
    const response = await fetch(url.toString(), {
      headers: this.headers
    });
    if (response.status === 404) {
      return new HakoBackendDocumentSnapshot<T>(docRef.id, undefined, false, docRef);
    }
    if (!response.ok) {
      await throwForStatus(response, `Failed to fetch document ${docRef.id}`);
    }
    const rawData = await response.json();
    const hydratedDoc = hydrateTimestamps(rawData);

    return new HakoBackendDocumentSnapshot<T>(
      docRef.id,
      hydratedDoc,
      true,
      docRef,
      (docRef as any).converter
    );
  }

  onSnapshot<T = DocumentData>(
    q: Query<T> | CollectionReference<T>,
    onNext: (snapshot: QuerySnapshot<T>) => void,
    onError?: (error: Error) => void
  ) {
    const queryObj = q instanceof CollectionReference ? new Query<T>(q) : q;
    const options = queryObj.buildOptions();
    const colName = queryObj.colRef.name;

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
        const docRef = new DocumentReference<T>(queryObj.colRef.client, queryObj.colRef.name, d.id);
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

    const unsubscribe = this.connection.subscribe(colName, options, queryObj.isGroup, (change) => {
      const { type, old_val, new_val } = change;
      const docId = (new_val?.id || old_val?.id);
      const oldIndex = currentDocs.findIndex((d: any) => (d as any).id === docId);

      let docChange: DocumentChange<T> | null = null;
      const docRef = new DocumentReference<T>(queryObj.colRef.client, queryObj.colRef.name, docId);

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
    });

    const loadInitial = () => {
      return this.getDocs<T>(queryObj).then(snapshot => {
        loadSucceeded = true;
        currentDocs = snapshot.docs.map(d => d.data());
        currentDocs.sort((a, b) => compareDocs(a, b, options.orderBy));
        isInitial = false;

        const docsList = currentDocs.map((d: any) => {
          const docRef = new DocumentReference<T>(queryObj.colRef.client, queryObj.colRef.name, d.id);
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
    const stopListeningIdentity = this.onIdentityChange(refetchOnIdentity);

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

  async setDoc<T = DocumentData>(docRef: DocumentReference<T>, data: T, options: { merge?: boolean } = {}) {
    // hakobackend splits replace vs merge across methods (no ?merge= flag):
    // merge -> PATCH, otherwise PUT.
    const method = options.merge ? "PATCH" : "PUT";
    const url = new URL(`/api/collections/${docRef.collectionName}/${docRef.id}`, BACKEND_URL);

    const response = await fetch(url.toString(), {
      method,
      headers: this.headers,
      body: JSON.stringify(data)
    });
    if (!response.ok) await throwForStatus(response, `Failed to set document ${docRef.id}`);
    const rawData = await response.json();
    return hydrateTimestamps(rawData);
  }

  async addDoc<T = DocumentData>(colRef: CollectionReference<T>, data: T) {
    const response = await fetch(new URL(`/api/collections/${colRef.name}`, BACKEND_URL).toString(), {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(data)
    });
    if (!response.ok) await throwForStatus(response, `Failed to add document to ${colRef.name}`);
    const rawData = await response.json();
    return hydrateTimestamps(rawData);
  }

  async updateDoc<T = DocumentData>(docRef: DocumentReference<T>, data: Partial<T>) {
    const response = await fetch(new URL(`/api/collections/${docRef.collectionName}/${docRef.id}`, BACKEND_URL).toString(), {
      method: "PATCH",
      headers: this.headers,
      body: JSON.stringify(data)
    });
    if (!response.ok) await throwForStatus(response, `Failed to update document ${docRef.id}`);
    const rawData = await response.json();
    return hydrateTimestamps(rawData);
  }

  async deleteDoc<T = DocumentData>(docRef: DocumentReference<T>) {
    const response = await fetch(new URL(`/api/collections/${docRef.collectionName}/${docRef.id}`, BACKEND_URL).toString(), {
      method: "DELETE",
      headers: this.headers
    });
    if (!response.ok) await throwForStatus(response, `Failed to delete document ${docRef.id}`);
    const rawData = await response.json();
    return hydrateTimestamps(rawData);
  }

  async indexCreate(collectionName: string, indexName: string, fields: string[]) {
    const response = await fetch(new URL(`/api/collections/${collectionName}/index`, BACKEND_URL).toString(), {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ name: indexName, fields })
    });
    if (!response.ok) await throwForStatus(response, `Failed to create index ${indexName} on ${collectionName}`);
    return response.json();
  }

  writeBatch() {
    const operations: Protocol.BatchOperation[] = [];
    return {
      set: <T = DocumentData>(docRef: DocumentReference<T>, data: T, options: { merge?: boolean } = {}) => {
        operations.push({ type: 'set', collection: docRef.collectionName, id: docRef.id, data, options });
      },
      update: <T = DocumentData>(docRef: DocumentReference<T>, data: Partial<T>) => {
        operations.push({ type: 'update', collection: docRef.collectionName, id: docRef.id, data });
      },
      delete: <T = DocumentData>(docRef: DocumentReference<T>) => {
        operations.push({ type: 'delete', collection: docRef.collectionName, id: docRef.id });
      },
      commit: async () => {
        const response = await fetch(new URL('/api/batch', BACKEND_URL).toString(), {
          method: 'POST',
          headers: this.headers,
          body: JSON.stringify({ operations })
        });
        if (!response.ok) await throwForStatus(response, 'Batch commit failed');
        const rawData = await response.json();
        return hydrateTimestamps(rawData);
      }
    };
  }

  async runTransaction(updateFunction: (transaction: any) => Promise<any>) {
    const operations: Protocol.BatchOperation[] = [];
    const transaction = {
      get: async <T = DocumentData>(docRef: DocumentReference<T>) => {
        const snap = await this.getDoc(docRef);
        operations.push({ type: 'get', collection: docRef.collectionName, id: docRef.id });
        return snap;
      },
      set: <T = DocumentData>(docRef: DocumentReference<T>, data: T, options: { merge?: boolean } = {}) => {
        operations.push({ type: 'set', collection: docRef.collectionName, id: docRef.id, data, options });
      },
      update: <T = DocumentData>(docRef: DocumentReference<T>, data: Partial<T>) => {
        operations.push({ type: 'update', collection: docRef.collectionName, id: docRef.id, data });
      },
      delete: <T = DocumentData>(docRef: DocumentReference<T>) => {
        operations.push({ type: 'delete', collection: docRef.collectionName, id: docRef.id });
      }
    };

    const result = await updateFunction(transaction);

    const response = await fetch(new URL('/api/transaction', BACKEND_URL).toString(), {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ operations })
    });

    if (!response.ok) await throwForStatus(response, 'Transaction failed');
    return result;
  }

  async getCountFromServer<T = DocumentData>(q: Query<T> | CollectionReference<T>) {
    return this.aggregate(q, [{ type: 'count' }]);
  }

  async getSumFromServer<T = DocumentData>(q: Query<T> | CollectionReference<T>, field: string) {
    return this.aggregate(q, [{ type: 'sum', field }]);
  }

  async getAverageFromServer<T = DocumentData>(q: Query<T> | CollectionReference<T>, field: string) {
    return this.aggregate(q, [{ type: 'avg', field }]);
  }

  private async aggregate<T = DocumentData>(q: Query<T> | CollectionReference<T>, aggregations: any[]) {
    const queryObj = q instanceof CollectionReference ? new Query<T>(q) : q;
    const options = queryObj.buildOptions();

    const response = await fetch(new URL(`/api/aggregate/${queryObj.colRef.name}`, BACKEND_URL).toString(), {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ options, aggregations })
    });

    if (!response.ok) {
      await throwForStatus(response, 'Aggregation failed');
    }

    const result = await response.json();
    return {
      data: () => result,
      // hakobackend keys results `{type}_{field}` (`count_count` for counts).
      count: result.count_count !== undefined ? result.count_count : result.count,
    };
  }

  async listCollections(): Promise<string[]> {
    const response = await fetch(new URL('/api/collections', BACKEND_URL).toString(), {
      headers: this.headers
    });
    if (!response.ok) await throwForStatus(response, 'Failed to fetch collections');
    return response.json();
  }

  async createCollection(name: string): Promise<{ success: boolean }> {
    const response = await fetch(new URL('/api/collections', BACKEND_URL).toString(), {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ name })
    });
    if (!response.ok) await throwForStatus(response, 'Failed to create collection');
    return response.json();
  }

  async getSystemInfo(): Promise<{ status: string; type: string }> {
    const response = await fetch(new URL('/api/health', BACKEND_URL).toString());
    if (!response.ok) await throwForStatus(response, 'Failed to fetch system info');
    const body = await response.json();
    // hakobackend reports `{status, db}`; legacy callers read `.type`.
    return { status: body.status, type: body.db ?? body.type };
  }

  // --- Local auth (BFF cookies + bearer-capable responses) ---

  async register(id: string, password: string, extra?: Record<string, any>) {
    const response = await fetch(new URL('/api/auth/register', BACKEND_URL).toString(), {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ id, password, ...(extra || {}) })
    });
    if (!response.ok) await throwForStatus(response, 'Registration failed');
    return response.json();
  }

  async login(id: string, password: string) {
    const response = await fetch(new URL('/api/auth/login', BACKEND_URL).toString(), {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ id, password })
    });
    if (!response.ok) await throwForStatus(response, 'Login failed');
    return response.json();
  }

  async logout() {
    const response = await fetch(new URL('/api/auth/logout', BACKEND_URL).toString(), {
      method: 'POST',
      headers: this.headers
    });
    if (!response.ok) await throwForStatus(response, 'Logout failed');
    return response.json();
  }

  async me() {
    const response = await fetch(new URL('/api/auth/me', BACKEND_URL).toString(), {
      headers: this.headers
    });
    if (!response.ok) await throwForStatus(response, 'Failed to fetch profile');
    return response.json();
  }

  // --- Tenants (admin) ---

  async createTenant(slug: string) {
    const response = await fetch(new URL('/api/tenants', BACKEND_URL).toString(), {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ slug })
    });
    if (!response.ok) await throwForStatus(response, 'Failed to create tenant');
    return response.json();
  }

  async listTenants(): Promise<string[]> {
    const response = await fetch(new URL('/api/tenants', BACKEND_URL).toString(), {
      headers: this.headers
    });
    if (!response.ok) await throwForStatus(response, 'Failed to list tenants');
    return response.json();
  }
}

/**
 * Reference Classes
 */
export class CollectionReference<T = DocumentData> {
  readonly path: string;

  constructor(
    public client: HakoBackendClient,
    public name: string,
    public converter: FirestoreDataConverter<T> | null = null
  ) {
    this.path = name;
  }

  withConverter<U>(converter: FirestoreDataConverter<U>): CollectionReference<U> {
    return new CollectionReference<U>(this.client, this.name, converter);
  }
}

export class DocumentReference<T = DocumentData> {
  readonly path: string;
  declare readonly __refType: T;

  constructor(
    public client: HakoBackendClient,
    public collectionName: string,
    public id: string
  ) {
    this.path = collectionName ? `${collectionName}/${id}` : id;
  }
}

export class Query<T = DocumentData> {
  constructor(
    public colRef: CollectionReference<T>,
    public constraints: QueryConstraint[] = [],
    public isGroup: boolean = false
  ) {}

  buildOptions(): Protocol.QueryOptions {
    const options: Protocol.QueryOptions = { filters: [], fields: [], orderBy: [] };
    this.constraints.forEach(c => c.apply(options));
    return options;
  }
}

/**
 * Snapshot Implementations
 */
class HakoBackendDocumentSnapshot<T> implements DocumentSnapshot<T> {
  constructor(
    public id: string,
    private _data: any | undefined,
    public exists: boolean,
    public ref: DocumentReference<T>,
    private converter: FirestoreDataConverter<T> | null = null
  ) {}

  data(): T | undefined {
    if (!this._data) return undefined;
    if (this.converter) {
      const rawSnap = new HakoBackendQueryDocumentSnapshot<any>(this.id, this._data, this.ref);
      return this.converter.fromFirestore(rawSnap);
    }
    return this._data as T;
  }
}

class HakoBackendQueryDocumentSnapshot<T> extends HakoBackendDocumentSnapshot<T> implements QueryDocumentSnapshot<T> {
  constructor(id: string, data: T, ref: DocumentReference<T>) {
    super(id, data, true, ref);
  }
  data(): T { return super.data()!; }
}

export const hakobackend = new HakoBackendClient();
