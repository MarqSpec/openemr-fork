import {queryOptions} from '@tanstack/react-query';

import {configKeys} from './query_keys';
import {readRuntimeConfig} from './runtime_config';

// reference: INTERFACES.md API-48

/**
 * API-48, read once when the app starts, beside API-42, and never again in the background: it is fixed for the life
 * of the token handler's process. No automatic retry — like the session read, a failure waits for the user's "Try
 * again" (or the connection coming back), and nothing signed-in renders until it has answered.
 */
export const runtimeConfigQuery = () =>
  queryOptions({
    queryKey: configKeys.runtime(),
    queryFn: ({signal}) => readRuntimeConfig(signal),
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
