import {QueryCache, QueryClient} from '@tanstack/react-query';

import {ApiError, isTransient} from './api_error';
import type {ApiId} from './api_error';

// reference: REQUIREMENTS.md FR-AUTH-5, FR-CARD-5

export interface QueryClientOptions {
  /** Runs once, on the first 401, after every cached query is dropped; the caller shows sign-in (FR-AUTH-5). */
  readonly onSessionOver: () => void;
  /** Delay before the one retry of a transient failure; tests pass 0. */
  readonly retryDelayMs?: number;
}

/** Clients whose session has ended; a client never comes back from here (sign-in reloads the app). */
const endedSessions = new WeakSet<QueryClient>();

/**
 * The app's QueryClient. A 401 anywhere means the session is over: cached patient data is cleared at once, and
 * every query built with {@link guardSession} refuses to reach the server again on this client.
 * Only server and network failures are retried, once; 401/403/404 and malformed responses never are, so a
 * refusal is shown instead of retry-looping. No refetch on focus or reconnect — refresh is explicit (FR-CARD-5), and
 * every read the token handler proxies counts as activity, so a background refetch would keep an unattended tablet
 * signed in.
 */
export function createQueryClient(options: QueryClientOptions): QueryClient {
  const {onSessionOver, retryDelayMs = 1000} = options;
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: error => {
        if (
          error instanceof ApiError &&
          error.failure.kind === 'session-over' &&
          !endedSessions.has(client)
        ) {
          endedSessions.add(client);
          client.clear();
          onSessionOver();
        }
      },
    }),
    defaultOptions: {
      queries: {
        retry: (failureCount, error) => failureCount < 1 && isTransient(error),
        retryDelay: retryDelayMs,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      },
    },
  });
  return client;
}

/** True once the client has seen a 401; it stays true for the client's lifetime. */
export function isSessionOver(client: QueryClient): boolean {
  return endedSessions.has(client);
}

/**
 * Wraps a read as a queryFn that fails with `session-over`, sending nothing, once the client's session has
 * ended. It lives in the queryFn because `enabled` cannot stop a fetch: `refetch()` ignores it, and a card may
 * pass its own. Sign-in is a top-level navigation that reloads the app with a new client.
 */
export function guardSession<T>(
  apiId: ApiId,
  read: (signal: AbortSignal) => Promise<T>,
): (context: {client: QueryClient; signal: AbortSignal}) => Promise<T> {
  return ({client, signal}) =>
    endedSessions.has(client)
      ? Promise.reject(
          new ApiError({
            kind: 'session-over',
            apiId,
            status: 401,
            body: {format: 'unrecognised'},
          }),
        )
      : read(signal);
}
