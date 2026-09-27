# hakobackend-ts

> Part of [**HakoDB**](https://github.com/hakodb/hakodb) — embedded Firestore-style document DB in Rust. This repo holds the TypeScript client for [`hakobackend`](https://github.com/hakodb/hakobackend) (pairs with the HTTP + WebSocket wire, not the native FFI — that's `@hakodb/client`).

Port of the legacy `rethink-firestore/ui/src/lib/client.ts`, adapted to hakobackend.

## Install

```sh
npm i @hakodb/backend
```

```ts
import { hakobackend, collection, doc, getDocs } from "@hakodb/backend";

const snap = await getDocs(collection(hakobackend as any, "users"));
```

Set `VITE_BACKEND_URL` (Vite) or `NEXT_PUBLIC_BACKEND_URL` (Next.js).

## Legacy mapping (what changed)

| Legacy | This client |
|---|---|
| `RethinkClient` | `HakoBackendClient` (same methods) |
| socket.io transport | native `WebSocket /ws` (auto-reconnect + resubscribe) |
| `setDoc(..., {merge:true})` via `PUT ?merge=` | `merge:true` → `PATCH`, else `PUT` |
| Errors as plain text | `{error, code?}` JSON parsed into messages |
| `getSystemInfo()` → `{status, type}` | mapped from `{status, db}` |
| aggregates | same calls; `count` reads `count_count` key |
| Firebase token in `setIdentity` | any bearer token (local JWT, etc.) |
| — | `+ register/login/logout/me` (local BFF) |
| — | `dispose()` to release the socket |

`id` is required on batch/transaction ops (400 otherwise). Unknown batch
`type` values are rejected — use `set/add/update/delete/get`.
