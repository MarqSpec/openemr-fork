import {z} from 'zod';

import {ApiError, httpFailure, parseErrorBody} from '../api_error';
import {readJson} from '../json_body';
import {BFF_SESSION_PATH} from './paths';

// reference: INTERFACES.md API-42 · REQUIREMENTS.md FR-UI-3, FR-AUTH-5, NFR-CON-2

/** Who is signed in and until when — never a token, never patient data. */
export interface Session {
  /** The clinician's own name; `null` when OpenEMR would not give it (BUG-10). */
  readonly displayName: string | null;
  /** ISO 8601: when the session ends if nothing else happens (idle deadline or the 10 h maximum). */
  readonly expiresAt: string;
  /**
   * How long until `expiresAt`, measured on the server's clock (its `Date` header) so a tablet clock that is off
   * cannot stretch the countdown; the tablet's own clock only when the answer carries no usable `Date`.
   */
  readonly expiresInMs: number;
  readonly idleTimeoutSeconds: number;
  readonly grantedScopes: readonly string[];
}

const sessionSchema = z.object({
  authenticated: z.literal(true),
  user: z.object({
    displayName: z
      .string()
      .nullable()
      .transform(name => {
        const trimmed = name?.trim();
        return trimmed === undefined || trimmed === '' ? null : trimmed;
      }),
  }),
  expiresAt: z.iso.datetime({offset: true}),
  idleTimeoutSeconds: z.number().int().positive(),
  grantedScopes: z.array(z.string()),
});

/**
 * Reads API-42. A 401 is `session-over` (nobody is signed in); a 2xx that is not the session shape is
 * `malformed-response`, so an odd answer never counts as signed in. Throws only {@link ApiError}.
 */
export async function readSession(signal?: AbortSignal): Promise<Session> {
  const apiId = 'API-42';
  let response: Response;
  try {
    response = await fetch(new URL(BFF_SESSION_PATH, window.location.origin), {
      method: 'GET',
      credentials: 'same-origin',
      headers: {Accept: 'application/json'},
      ...(signal === undefined ? {} : {signal}),
    });
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
  const parsed = sessionSchema.safeParse(json);
  if (!parsed.success) {
    throw new ApiError({
      kind: 'malformed-response',
      apiId,
      status: response.status,
    });
  }
  const {user, expiresAt, idleTimeoutSeconds, grantedScopes} = parsed.data;
  const serverNow = Date.parse(response.headers.get('Date') ?? '');
  const expiresInMs =
    Date.parse(expiresAt) - (Number.isNaN(serverNow) ? Date.now() : serverNow);
  return {
    displayName: user.displayName,
    expiresAt,
    expiresInMs,
    idleTimeoutSeconds,
    grantedScopes,
  };
}
