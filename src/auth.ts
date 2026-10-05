/**
 * Auth-token bridge (framework-free, vendor-free).
 *
 * The client speaks bearer tokens (`setIdentity`) but never fetches them:
 * identity comes from the app's auth system (Firebase, local, OIDC —
 * anything that can produce a token). The app provides a TokenSource;
 * this module wires it into the WS layer and, optionally, a fetch
 * interceptor for the REST calls. The lib never imports an auth SDK.
 */

import type { HakoBackendClient } from './client';

/** Token provider owned by the app. `subscribe` fires on identity change. */
export interface TokenSource {
  getToken(): Promise<string | null>;
  subscribe(cb: () => void): () => void;
}

export interface BindOptions {
  /**
   * Patch `window.fetch` to attach the bearer token (default true).
   * Only matched URLs are touched (default: `/api/`); SSR-safe
   * (no window = no patch, WS identity still binds).
   */
  interceptFetch?: boolean;
  matchUrls?: RegExp[];
  /** Push the token into the WS layer (default true). */
  bindSocket?: boolean;
}

const DEFAULT_MATCH = [/\/api\//];

/**
 * Bind a token source to a client. Explicit opt-in (call once at app
 * boot); returns an unbind that restores `fetch` and clears identity.
 */
export function bindTokenSource(
  client: HakoBackendClient,
  source: TokenSource,
  opts: BindOptions = {},
): () => void {
  const { interceptFetch = true, matchUrls = DEFAULT_MATCH, bindSocket = true } = opts;

  let stopped = false;
  const push = () => {
    if (stopped) return;
    void source.getToken().then((t) => {
      if (!stopped) client.setIdentity(t ? { token: t } : null);
    });
  };
  const stopSource = source.subscribe(push);
  if (bindSocket) push();

  let restoreFetch: (() => void) | null = null;
  if (interceptFetch && typeof window !== 'undefined' && typeof window.fetch === 'function') {
    // ponytail: keep the original REFERENCE for restore (a bound copy
    // would fail identity checks); call it with explicit receiver.
    const originalFetch = window.fetch;
    window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (matchUrls.some((re) => re.test(url))) {
        try {
          const token = await source.getToken();
          if (token) {
            init = init || {};
            const headers = new Headers(init.headers);
            if (!headers.has('Authorization')) {
              headers.set('Authorization', `Bearer ${token}`);
            }
            init.headers = headers;
          }
        } catch {
          // Token fetch failed: proceed unauthenticated (server decides).
        }
      }
      return originalFetch.call(window, input, init);
    }) as typeof window.fetch;
    restoreFetch = () => {
      window.fetch = originalFetch;
    };
  }

  return () => {
    stopped = true;
    stopSource();
    restoreFetch?.();
  };
}
