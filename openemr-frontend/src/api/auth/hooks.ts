import {queryOptions} from '@tanstack/react-query';

import {guardSession} from '../query_client';
import {keepSessionAlive} from './keep_alive';
import {authKeys} from './query_keys';
import {readSession} from './session';

// reference: INTERFACES.md API-42, API-46 · a separate change (note 87130), a separate change

/**
 * API-42, read once when the app starts and never again in the background: no polling, no refetch on focus,
 * reconnect or remount, and no automatic retry — a failure waits for the user's "Try again". The idle countdown
 * decides when to read it next.
 */
export const sessionQuery = () =>
  queryOptions({
    queryKey: authKeys.session(),
    queryFn: guardSession('API-42', readSession),
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

/**
 * API-42 re-read by the idle countdown when the warning is due. Not activity on the
 * server. Its own key, never cached or retried, so a failed re-read cannot put the session the shell draws from
 * ({@link sessionQuery}) into error; a 401 is still session-over for the whole client.
 */
export const sessionCheckQuery = () =>
  queryOptions({
    queryKey: authKeys.sessionCheck(),
    queryFn: guardSession('API-42', readSession),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });

/**
 * "Stay signed in": API-46, which restarts the token handler's idle clock (FR-BFF-4) without calling
 * OpenEMR and answers the new expiry. Also sent automatically when the warning is due after touch, key or
 * scroll within the idle period. Fetched on demand only: never cached, never retried, never refetched. A 401 is
 * session-over like any read.
 */
export const keepAliveQuery = () =>
  queryOptions({
    queryKey: authKeys.keepAlive(),
    queryFn: guardSession('API-46', keepSessionAlive),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
