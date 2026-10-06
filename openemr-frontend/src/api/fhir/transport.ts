import {ApiError, httpFailure, parseErrorBody} from '../api_error';
import type {ApiId} from '../api_error';
import {readJson} from '../json_body';

// reference: INTERFACES.md API-44 · REQUIREMENTS.md NFR-CON-2, FR-BFF-3

/** The token handler's allow-listed FHIR read proxy, same origin as the SPA. */
export const BFF_FHIR_BASE = '/bff/fhir';

export interface FhirGetRequest {
  /** The inventory row this read implements; errors carry it instead of any request detail. */
  readonly apiId: ApiId;
  /** Path under the FHIR base, e.g. `Patient/{id}`; ids are FHIR-id-validated by the caller. */
  readonly path: string;
  readonly params?: Readonly<Record<string, string>> | undefined;
  readonly signal?: AbortSignal | undefined;
}

/**
 * The only `fetch` in the SPA's FHIR reads. The browser sends the `HttpOnly` session cookie; the token handler
 * attaches the bearer token — the SPA never sees one (PRD Q-7). Resolves with the JSON body of a 2xx and
 * throws {@link ApiError} for anything else; a caller's abort propagates unchanged.
 */
export async function fhirGet(request: FhirGetRequest): Promise<unknown> {
  const {apiId, path, params, signal} = request;
  const url = new URL(`${BFF_FHIR_BASE}/${path}`, window.location.origin);
  for (const [name, value] of Object.entries(params ?? {})) {
    url.searchParams.append(name, value);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      credentials: 'same-origin',
      headers: {Accept: 'application/fhir+json'},
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
  if (json === undefined) {
    throw new ApiError({
      kind: 'malformed-response',
      apiId,
      status: response.status,
    });
  }
  return json;
}
