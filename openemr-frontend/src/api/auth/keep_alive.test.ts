import {http, HttpResponse} from 'msw';
import {describe, expect, it} from 'vitest';

import {server} from '../../test/msw_server';
import {ApiError} from '../api_error';
import type {ApiFailure} from '../api_error';
import {keepSessionAlive} from './keep_alive';

// reference: REQUIREMENTS.md FR-AUTH-4, FR-BFF-4, FR-BFF-6 · INTERFACES.md API-46

const ACTIVITY_URL = '/bff/session/activity';
const EXPIRES_AT = '2026-09-25T18:00:00.000Z';

async function failureOf(promise: Promise<unknown>): Promise<ApiFailure> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error.failure;
    throw error;
  }
  throw new Error('expected the request to fail');
}

describe('given "Stay signed in" (API-46: the token handler records activity)', () => {
  it('when it is sent, then it is one same-origin POST to /bff/session/activity with no body and no Authorization header — never a FHIR read', async () => {
    const seen: {request: Request; body: string}[] = [];
    const fhir: string[] = [];
    server.use(
      http.post(ACTIVITY_URL, async ({request}) => {
        seen.push({request, body: await request.clone().text()});
        return HttpResponse.json({expiresAt: EXPIRES_AT});
      }),
      http.all('/bff/fhir/*', ({request}) => {
        fhir.push(request.url);
        return HttpResponse.json({});
      }),
    );

    await keepSessionAlive();

    expect(seen).toHaveLength(1);
    const {request, body} = seen[0] ?? {};
    const url = new URL(request?.url ?? '');
    expect(url.origin).toBe(window.location.origin);
    expect(url.pathname).toBe(ACTIVITY_URL);
    expect(url.search).toBe('');
    expect(request?.method).toBe('POST');
    expect(request?.credentials).toBe('same-origin');
    expect(request?.headers.get('Authorization')).toBeNull();
    expect(request?.headers.get('Content-Type')).toBeNull();
    expect(body).toBe('');
    expect(fhir).toEqual([]);
  });

  it('when the token handler answers, then the new expiry is returned with the time left measured on the server clock (guards a countdown that outlives the server session)', async () => {
    server.use(
      http.post(ACTIVITY_URL, () =>
        HttpResponse.json(
          {expiresAt: EXPIRES_AT},
          {headers: {Date: 'Fri, 25 Sep 2026 17:45:00 GMT'}},
        ),
      ),
    );

    await expect(keepSessionAlive()).resolves.toEqual({
      expiresAt: EXPIRES_AT,
      expiresInMs: 15 * 60 * 1000,
    });
  });

  it('when the answer is not the expiry shape, then it fails as malformed for API-46, never as extended', async () => {
    server.use(
      http.post(ACTIVITY_URL, () =>
        HttpResponse.json({expiresAt: 'tomorrow-ish'}),
      ),
    );
    expect(await failureOf(keepSessionAlive())).toMatchObject({
      kind: 'malformed-response',
      apiId: 'API-46',
    });
  });

  it('when the session is already over (401), then it fails as session-over for API-46', async () => {
    server.use(
      http.post(ACTIVITY_URL, () =>
        HttpResponse.json({error: 'unauthenticated'}, {status: 401}),
      ),
    );
    expect(await failureOf(keepSessionAlive())).toMatchObject({
      kind: 'session-over',
      apiId: 'API-46',
    });
  });

  it('when the server fails (503), then it is a server error, not a sign-out', async () => {
    server.use(
      http.post(ACTIVITY_URL, () => new HttpResponse(null, {status: 503})),
    );
    expect(await failureOf(keepSessionAlive())).toMatchObject({
      kind: 'server-error',
      apiId: 'API-46',
    });
  });

  it('when the network fails, then it is a network error for API-46', async () => {
    server.use(http.post(ACTIVITY_URL, () => HttpResponse.error()));
    expect(await failureOf(keepSessionAlive())).toMatchObject({
      kind: 'network-error',
      apiId: 'API-46',
    });
  });
});
