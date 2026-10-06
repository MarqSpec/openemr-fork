import {z} from 'zod';

import {ApiError, httpFailure, parseErrorBody} from '../api_error';
import {readJson} from '../json_body';
import {BFF_SESSION_ACTIVITY_PATH} from './paths';

// reference: INTERFACES.md API-46 · REQUIREMENTS.md FR-AUTH-4, FR-BFF-4, FR-BFF-6

/** Where the server session now ends, after the keep-alive restarted its idle clock. */
export interface SessionExtension {
  /** ISO 8601: the new expiry (the idle deadline from now, or the 10 h maximum if that comes first). */
  readonly expiresAt: string;
  /** Time until `expiresAt` on the server's clock (its `Date` header), the tablet's only when there is none. */
  readonly expiresInMs: number;
}

const extensionSchema = z.object({expiresAt: z.iso.datetime({offset: true})});

/**
 * "Stay signed in": API-46, a same-origin POST with no body that the token handler counts as activity without
 * calling OpenEMR (the CSRF guard reads the `Origin` / `Sec-Fetch-Site` the browser adds). A 401 is `session-over`;
 * a 2xx without the expiry is `malformed-response`, never an extension. Throws only {@link ApiError}.
 */
export async function keepSessionAlive(
  signal?: AbortSignal,
): Promise<SessionExtension> {
  const apiId = 'API-46';
  let response: Response;
  try {
    response = await fetch(
      new URL(BFF_SESSION_ACTIVITY_PATH, window.location.origin),
      {
        method: 'POST',
        credentials: 'same-origin',
        headers: {Accept: 'application/json'},
        ...(signal === undefined ? {} : {signal}),
      },
    );
  } catch (error) {
    if (signal?.aborted === true) throw error;
    throw new ApiError({kind: 'network-error', apiId});
  }

  const json = await readJson(response, signal);
  if (!response.ok) {
    throw new ApiError(
      httpFailure(apiId, response.status, parseErrorBody(json)),
    );
  }
  const parsed = extensionSchema.safeParse(json);
  if (!parsed.success) {
    throw new ApiError({
      kind: 'malformed-response',
      apiId,
      status: response.status,
    });
  }
  const {expiresAt} = parsed.data;
  const serverNow = Date.parse(response.headers.get('Date') ?? '');
  const expiresInMs =
    Date.parse(expiresAt) - (Number.isNaN(serverNow) ? Date.now() : serverNow);
  return {expiresAt, expiresInMs};
}
