// HakoBackend TypeScript client — port of the legacy rethink-firestore
// `ui/src/lib/client.ts`, adapted to the hakobackend wire protocol:
// native WebSocket `/ws` (no socket.io), PATCH-based merge, `{error}`
// failure bodies, local-auth helpers.
//
// Surface (classes, methods, constraints, snapshots) is intentionally
// identical so consumer code migrates by changing imports.

import { hydrateTimestamps } from "./hydrate";
import { watchSnapshot } from "./watch";
import type { SnapshotHost } from "./watch";

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

/** File metadata doc sub-object (managed files, `/api/files/*`). */
export interface FileMeta {
  name: string;
  mime: string;
  size: number;
  sha256: string;
  state: 'ready' | 'pending';
  createdAt?: string;
  updatedAt?: string;
  uploader?: string;
  pendingSince?: number;
}

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
  private subscriptions: Map<string, { tableName: string; options: Protocol.QueryOptions | null; isGroup: boolean; db: string }> = new Map();
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
    // ponytail: guard the constructor (not just the callbacks) — an empty
    // base URL (tests, SSR, misconfig) throws synchronously here, which
    // used to crash module scope. Degrade to disconnected + backoff.
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.isConnected = false;
      if (!this.closed) {
        setTimeout(() => this.connect(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10000);
      }
      return;
    }
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
          db: subscription.db,
          token: this.identity?.token,
        });
      });
    }
  }

  subscribe(table: string, options: Protocol.QueryOptions | null, isGroup: boolean, callback: (change: Protocol.ChangeEvent) => void, db = 'default') {
    // Two live queries on the same collection with different filters must get
    // distinct server-side subscriptions, so include a stable options fingerprint
    // in the key. The server treats this key as opaque. The db joins the key:
    // same collection in two databases are different feeds.
    const subscriptionKey = `${isGroup ? 'group:' : ''}${db}|${table}|${JSON.stringify(options || {})}`;
    this.subscriptions.set(subscriptionKey, { tableName: table, options, isGroup, db });
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
      db,
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
 * Build an API URL, appending `?db=` only for non-default databases
 * (single-db URLs stay byte-identical to before). Pure (takes the base
 * explicitly) so URL shaping is unit-testable without a client.
 */
export function buildApiUrl(base: string, path: string, db?: string): URL {
  const url = new URL(path, base);
  if (db && db !== 'default') url.searchParams.append('db', db);
  return url;
}
export class HakoBackendClient {
  private connection: ConnectionManager;
  private identity: { token: string } | null = null;
  private identityListeners: Array<() => void> = [];
  /**
   * Default database for every call (`?db=`). Single-db apps never touch
   * this; multi-db apps set it per reference (`collection(name, db)`) or
   * per bulk call — or point it once via `useDatabase`.
   */
  defaultDatabase = 'default';

  constructor() {
    this.connection = new ConnectionManager();
  }

  /** Point this client at another database (default for later calls). */
  useDatabase(name: string) {
    this.defaultDatabase = name;
  }

  /**
   * Build an API URL, appending `?db=` only for non-default databases
   * (single-db URLs stay byte-identical to before).
   */
  private apiUrl(path: string, db?: string): URL {
    const name = db ?? this.defaultDatabase;
    return buildApiUrl(BACKEND_URL || 'http://localhost', path, name);
  }

  /** Effective db: explicit override ?? reference db ?? client default. */
  private dbOf(ref?: { db?: string }, override?: string): string {
    return override ?? ref?.db ?? this.defaultDatabase;
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

  collection<T = DocumentData>(name: string, db?: string) {
    return new CollectionReference<T>(this, name, null, db);
  }

  collectionGroup<T = DocumentData>(name: string, db?: string) {
    return new Query<T>(new CollectionReference<T>(this, name, null, db), [], true, db);
  }

  doc<T = DocumentData>(collectionName: string, id: string, db?: string) {
    return new DocumentReference<T>(this, collectionName, id, db);
  }

  async getDocs<T = DocumentData>(q: Query<T> | CollectionReference<T>): Promise<QuerySnapshot<T>> {
    const queryObj = q instanceof CollectionReference ? new Query<T>(q) : q;
    const options = queryObj.buildOptions();
    const baseUrl = queryObj.isGroup ? `/api/collectionGroup/${queryObj.colRef.name}` : `/api/collections/${queryObj.colRef.name}`;

    const url = this.apiUrl(baseUrl, queryObj.resolvedDb(this));
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
    const url = this.apiUrl(`/api/collections/${docRef.collectionName}/${docRef.id}`, this.dbOf(docRef));
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
    // ponytail: the engine lives in watch.ts (testable behind a fake
    // host); this method only binds the real client as the host.
    const queryObj = q instanceof CollectionReference ? new Query<T>(q) : q;
    return watchSnapshot(
      this.host(),
      queryObj,
      queryObj.colRef.name,
      queryObj.resolvedDb(this),
      onNext,
      onError,
    );
  }

  /**
   * This client bound as a SnapshotHost (powers the react hooks and any
   * custom watcher UI without touching the socket layer directly).
   */
  host(): SnapshotHost {
    return {
      getDocs: <U>(qq: Query<U> | CollectionReference<U>) => this.getDocs<U>(qq),
      onIdentityChange: (cb: () => void) => this.onIdentityChange(cb),
      subscribe: (
        table: string,
        options: Protocol.QueryOptions | null,
        isGroup: boolean,
        cb: (change: Protocol.ChangeEvent) => void,
        db?: string,
      ) => this.connection.subscribe(table, options, isGroup, cb, db),
    };
  }

  async setDoc<T = DocumentData>(docRef: DocumentReference<T>, data: T, options: { merge?: boolean } = {}) {
    // hakobackend splits replace vs merge across methods (no ?merge= flag):
    // merge -> PATCH, otherwise PUT.
    const method = options.merge ? "PATCH" : "PUT";
    const url = this.apiUrl(`/api/collections/${docRef.collectionName}/${docRef.id}`, this.dbOf(docRef));

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
    const response = await fetch(this.apiUrl(`/api/collections/${colRef.name}`, this.dbOf(colRef)).toString(), {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(data)
    });
    if (!response.ok) await throwForStatus(response, `Failed to add document to ${colRef.name}`);
    const rawData = await response.json();
    return hydrateTimestamps(rawData);
  }

  async updateDoc<T = DocumentData>(docRef: DocumentReference<T>, data: Partial<T>) {
    const response = await fetch(this.apiUrl(`/api/collections/${docRef.collectionName}/${docRef.id}`, this.dbOf(docRef)).toString(), {
      method: "PATCH",
      headers: this.headers,
      body: JSON.stringify(data)
    });
    if (!response.ok) await throwForStatus(response, `Failed to update document ${docRef.id}`);
    const rawData = await response.json();
    return hydrateTimestamps(rawData);
  }

  async deleteDoc<T = DocumentData>(docRef: DocumentReference<T>) {
    const response = await fetch(this.apiUrl(`/api/collections/${docRef.collectionName}/${docRef.id}`, this.dbOf(docRef)).toString(), {
      method: "DELETE",
      headers: this.headers
    });
    if (!response.ok) await throwForStatus(response, `Failed to delete document ${docRef.id}`);
    const rawData = await response.json();
    return hydrateTimestamps(rawData);
  }

  async indexCreate(collectionName: string, indexName: string, fields: string[], db?: string) {
    const response = await fetch(this.apiUrl('/api/indexes', db).toString(), {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ collection: collectionName, name: indexName, fields })
    });
    if (!response.ok) await throwForStatus(response, `Failed to create index ${indexName} on ${collectionName}`);
    return response.json();
  }

  /**
   * Move docs between collections (archive/restore): timestamp-preserving
   * put at dst first, fresh tombstone at src; returns {moved, missing}.
   * Refusals (excluded sides, same-side) surface as thrown errors.
   */
  async relocateDocs(src: string, dst: string, ids: string[], db?: string): Promise<{ moved: string[]; missing: string[] }> {
    const response = await fetch(this.apiUrl('/api/relocate', db).toString(), {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ src, dst, ids })
    });
    if (!response.ok) await throwForStatus(response, `Failed to relocate ${src} -> ${dst}`);
    return response.json();
  }

  /** Explicit load of one (usually lazy archive) collection. */
  async loadCollection(collectionName: string, db?: string) {
    const response = await fetch(this.apiUrl('/api/collections/load', db).toString(), {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ collection: collectionName })
    });
    if (!response.ok) await throwForStatus(response, `Failed to load collection ${collectionName}`);
    return response.json();
  }

  /** Explicit evict of one lazy collection (refuses non-lazy). */
  async unloadCollection(collectionName: string, db?: string) {
    const response = await fetch(this.apiUrl('/api/collections/unload', db).toString(), {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ collection: collectionName })
    });
    if (!response.ok) await throwForStatus(response, `Failed to unload collection ${collectionName}`);
    return response.json();
  }

  /** Archive-group collections present but not loaded. */
  async unloadedCollections(db?: string): Promise<string[]> {
    const response = await fetch(this.apiUrl('/api/collections/unloaded', db).toString(), {
      headers: this.headers
    });
    if (!response.ok) await throwForStatus(response, 'Failed to list unloaded collections');
    return response.json();
  }

  /**
   * Single-field read without fetching the whole doc: GET
   * /api/collections/{coll}/{id}/{field.path}. Returns the raw JSON
   * value (missing fields fall back to the legacy list shape server-side,
   * so an empty array is ambiguous — check doc existence first when it
   * matters). Dotted paths descend nested objects.
   */
  async getField<T = DocumentData>(docRef: DocumentReference<T>, fieldPath: string): Promise<any> {
    const response = await fetch(this.apiUrl(`/api/collections/${docRef.collectionName}/${docRef.id}/${fieldPath}`, this.dbOf(docRef)).toString(), {
      headers: this.headers
    });
    if (response.status === 404) {
      return undefined;
    }
    if (!response.ok) await throwForStatus(response, `Failed to fetch field ${fieldPath} of ${docRef.id}`);
    return hydrateTimestamps(await response.json());
  }

  writeBatch(db?: string) {
    const operations: Protocol.BatchOperation[] = [];
    const targetDb = db ?? this.defaultDatabase;
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
        const response = await fetch(this.apiUrl('/api/batch', targetDb).toString(), {
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

  async runTransaction(updateFunction: (transaction: any) => Promise<any>, db?: string) {
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

    const response = await fetch(this.apiUrl('/api/transaction', db).toString(), {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ operations })
    });

    if (!response.ok) await throwForStatus(response, 'Transaction failed');
    return result;
  }

  async getCountFromServer<T = DocumentData>(q: Query<T> | CollectionReference<T>, db?: string) {
    return this.aggregate(q, [{ type: 'count' }], db);
  }

  async getSumFromServer<T = DocumentData>(q: Query<T> | CollectionReference<T>, field: string, db?: string) {
    return this.aggregate(q, [{ type: 'sum', field }], db);
  }

  async getAverageFromServer<T = DocumentData>(q: Query<T> | CollectionReference<T>, field: string, db?: string) {
    return this.aggregate(q, [{ type: 'avg', field }], db);
  }

  private async aggregate<T = DocumentData>(q: Query<T> | CollectionReference<T>, aggregations: any[], db?: string) {
    const queryObj = q instanceof CollectionReference ? new Query<T>(q) : q;
    const options = queryObj.buildOptions();

    const response = await fetch(this.apiUrl(`/api/aggregate/${queryObj.colRef.name}`, db ?? queryObj.resolvedDb(this)).toString(), {
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

  // --- Managed files (/api/files/*): byte files + metadata docs.
  // Metadata lives in the addressed collection; bytes are
  // content-addressed server-side. See HTTP_CONTRACT §15.

  async uploadFile(
    collection: string,
    id: string,
    file: Blob,
    opts: { field?: string; fileName?: string; db?: string } = {},
  ): Promise<{ id: string; file: FileMeta }> {
    const field = opts.field && opts.field !== 'file' ? `/${opts.field}` : '';
    const form = new FormData();
    form.append('file', file, opts.fileName ?? (file as File).name ?? 'upload');
    const response = await fetch(this.apiUrl(`/api/files/${collection}/${id}${field}`, opts.db).toString(), {
      method: 'POST',
      headers: this.authHeaders(),
      body: form,
    });
    if (!response.ok) await throwForStatus(response, `Failed to upload file to ${collection}/${id}`);
    return response.json();
  }

  async uploadFiles(
    collection: string,
    files: Blob[],
    opts: { fileName?: (i: number) => string; db?: string } = {},
  ): Promise<Array<{ id: string; file: FileMeta }>> {
    const form = new FormData();
    files.forEach((f, i) => form.append('file', f, opts.fileName?.(i) ?? (f as File).name ?? `upload-${i}`));
    const response = await fetch(this.apiUrl(`/api/files/${collection}`, opts.db).toString(), {
      method: 'POST',
      headers: this.authHeaders(),
      body: form,
    });
    if (!response.ok) await throwForStatus(response, `Failed batch upload to ${collection}`);
    return response.json();
  }

  async downloadFile(
    collection: string,
    id: string,
    opts: { field?: string; db?: string } = {},
  ): Promise<Blob> {
    const field = opts.field && opts.field !== 'file' ? `/${opts.field}` : '';
    const response = await fetch(this.apiUrl(`/api/files/${collection}/${id}${field}`, opts.db).toString(), {
      headers: this.authHeaders(),
    });
    if (!response.ok) await throwForStatus(response, `Failed to download file ${collection}/${id}`);
    return response.blob();
  }

  async deleteFile(
    collection: string,
    id: string,
    opts: { field?: string; db?: string } = {},
  ): Promise<{ ok: boolean }> {
    const field = opts.field && opts.field !== 'file' ? `/${opts.field}` : '';
    const response = await fetch(this.apiUrl(`/api/files/${collection}/${id}${field}`, opts.db).toString(), {
      method: 'DELETE',
      headers: this.authHeaders(),
    });
    if (!response.ok) await throwForStatus(response, `Failed to delete file ${collection}/${id}`);
    return response.json();
  }

  /** Mint a signed URL (relative; same-origin usable as-is). */
  async signFile(
    collection: string,
    id: string,
    expSecs: number,
    opts: { field?: string; db?: string } = {},
  ): Promise<{ url: string; exp: number }> {
    const field = opts.field && opts.field !== 'file' ? `/${opts.field}` : '';
    const url = this.apiUrl(`/api/files/${collection}/${id}${field}`, opts.db);
    url.searchParams.append('sign', String(expSecs));
    const response = await fetch(url.toString(), { headers: this.authHeaders() });
    if (!response.ok) await throwForStatus(response, `Failed to sign file ${collection}/${id}`);
    return response.json();
  }

  /** Authorization header only (multipart bodies set their own content type). */
  private authHeaders(): HeadersInit {
    const h: HeadersInit = {};
    if (this.identity?.token) {
      h["Authorization"] = `Bearer ${this.identity.token}`;
    }
    return h;
  }

  async listCollections(db?: string): Promise<string[]> {
    const response = await fetch(this.apiUrl('/api/collections', db).toString(), {
      headers: this.headers
    });
    if (!response.ok) await throwForStatus(response, 'Failed to fetch collections');
    return response.json();
  }

  async createCollection(name: string, db?: string): Promise<{ success: boolean }> {
    const response = await fetch(this.apiUrl('/api/collections', db).toString(), {
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
}

/**
 * Reference Classes
 */
export class CollectionReference<T = DocumentData> {
  readonly path: string;

  constructor(
    public client: HakoBackendClient,
    public name: string,
    public converter: FirestoreDataConverter<T> | null = null,
    public db?: string
  ) {
    this.path = name;
  }

  withConverter<U>(converter: FirestoreDataConverter<U>): CollectionReference<U> {
    return new CollectionReference<U>(this.client, this.name, converter, this.db);
  }
}

export class DocumentReference<T = DocumentData> {
  readonly path: string;
  declare readonly __refType: T;

  constructor(
    public client: HakoBackendClient,
    public collectionName: string,
    public id: string,
    public db?: string
  ) {
    this.path = collectionName ? `${collectionName}/${id}` : id;
  }
}

export class Query<T = DocumentData> {
  constructor(
    public colRef: CollectionReference<T>,
    public constraints: QueryConstraint[] = [],
    public isGroup: boolean = false,
    public db?: string
  ) {}

  /** Effective database: query override ?? collection db (server default applies when unset). */
  resolvedDb(client: HakoBackendClient): string {
    return this.db ?? this.colRef.db ?? client.defaultDatabase;
  }

  buildOptions(): Protocol.QueryOptions {
    const options: Protocol.QueryOptions = { filters: [], fields: [], orderBy: [] };
    this.constraints.forEach(c => c.apply(options));
    return options;
  }
}

/**
 * Snapshot Implementations (exported for the watch engine + tests;
 * consumers normally meet these through snapshots, not imports).
 */
export class HakoBackendDocumentSnapshot<T> implements DocumentSnapshot<T> {
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

export class HakoBackendQueryDocumentSnapshot<T> extends HakoBackendDocumentSnapshot<T> implements QueryDocumentSnapshot<T> {
  constructor(id: string, data: T, ref: DocumentReference<T>) {
    super(id, data, true, ref);
  }
  data(): T { return super.data()!; }
}

export const hakobackend = new HakoBackendClient();
