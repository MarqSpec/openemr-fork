import {http, HttpResponse} from 'msw';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {server} from '../../test/msw_server';
import {
  CANARY,
  operationOutcome,
  patient,
  restEnvelope,
} from '../../test/fhir_fixtures';
import {ApiError} from '../api_error';
import type {ApiFailure} from '../api_error';
import {fhirGet} from './transport';

// reference: INTERFACES.md API-44 · REQUIREMENTS.md NFR-CON-2, FR-AUTH-5, NFR-SEC-6 · REQUIREMENTS.md BUG-33

const URL_PATTERN = '/bff/fhir/Patient/p1';

afterEach(() => {
  vi.restoreAllMocks();
});

async function failureOf(promise: Promise<unknown>): Promise<ApiFailure> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error.failure;
    throw error;
  }
  throw new Error('expected the request to fail');
}

describe('given a FHIR read through the token handler', () => {
  it('when it is sent, then it is a same-origin GET to /bff/fhir with the session cookie and no Authorization header', async () => {
    let seen: Request | undefined;
    server.use(
      http.get(URL_PATTERN, ({request}) => {
        seen = request;
        return HttpResponse.json(patient());
      }),
    );

    await fhirGet({apiId: 'API-12', path: 'Patient/p1'});

    expect(seen).toBeDefined();
    const url = new URL(seen?.url ?? '');
    expect(url.origin).toBe(window.location.origin);
    expect(url.pathname).toBe('/bff/fhir/Patient/p1');
    expect(seen?.method).toBe('GET');
    expect(seen?.credentials).toBe('same-origin');
    expect(seen?.headers.get('Authorization')).toBeNull();
    expect(seen?.headers.get('Accept')).toBe('application/fhir+json');
  });

  it('when it has search parameters, then they are sent as the query string', async () => {
    let query = '';
    server.use(
      http.get('/bff/fhir/Condition', ({request}) => {
        query = new URL(request.url).search;
        return HttpResponse.json({resourceType: 'Bundle'});
      }),
    );

    await fhirGet({
      apiId: 'API-14',
      path: 'Condition',
      params: {patient: 'p1', category: 'problem-list-item'},
    });

    expect(query).toBe('?patient=p1&category=problem-list-item');
  });

  it('when the server answers 200 with JSON, then the parsed body is returned', async () => {
    server.use(http.get(URL_PATTERN, () => HttpResponse.json(patient())));

    await expect(
      fhirGet({apiId: 'API-12', path: 'Patient/p1'}),
    ).resolves.toMatchObject({resourceType: 'Patient'});
  });
});

describe('given the token handler refuses or fails the read', () => {
  it('when it answers 401, then the failure is "session over" (FR-AUTH-5)', async () => {
    server.use(
      http.get(URL_PATTERN, () =>
        HttpResponse.json({error: 'unauthenticated'}, {status: 401}),
      ),
    );

    expect(
      await failureOf(fhirGet({apiId: 'API-12', path: 'Patient/p1'})),
    ).toMatchObject({kind: 'session-over', apiId: 'API-12', status: 401});
  });

  it('when it answers 403 with an OperationOutcome, then the failure is "not authorised" and keeps only the issue codes', async () => {
    server.use(
      http.get(URL_PATTERN, () =>
        HttpResponse.json(operationOutcome('forbidden'), {status: 403}),
      ),
    );

    expect(
      await failureOf(fhirGet({apiId: 'API-12', path: 'Patient/p1'})),
    ).toEqual({
      kind: 'not-authorised',
      apiId: 'API-12',
      status: 403,
      body: {format: 'operation-outcome', issueCodes: ['forbidden']},
    });
  });

  it('when an OperationOutcome issue code is not a FHIR IssueType, then it is dropped, not kept as text (NFR-SEC-6)', async () => {
    server.use(
      http.get(URL_PATTERN, () =>
        HttpResponse.json(
          {
            resourceType: 'OperationOutcome',
            issue: [
              {severity: 'error', code: 'forbidden'},
              {severity: 'error', code: 'zzcanary-fakename'},
              {severity: 'error', code: 'not-found'},
            ],
          },
          {status: 403},
        ),
      ),
    );

    expect(
      await failureOf(fhirGet({apiId: 'API-12', path: 'Patient/p1'})),
    ).toMatchObject({
      body: {
        format: 'operation-outcome',
        issueCodes: ['forbidden', 'not-found'],
      },
    });
  });

  it('when it answers 404, then the failure is "not found"', async () => {
    server.use(
      http.get(URL_PATTERN, () =>
        HttpResponse.json(operationOutcome('not-found'), {status: 404}),
      ),
    );

    expect(
      await failureOf(fhirGet({apiId: 'API-12', path: 'Patient/p1'})),
    ).toMatchObject({kind: 'not-found', status: 404});
  });

  it('when it answers 400 with the REST envelope instead of an OperationOutcome, then the envelope is recognised (BUG-33)', async () => {
    server.use(
      http.get(URL_PATTERN, () =>
        HttpResponse.json(restEnvelope(), {status: 400}),
      ),
    );

    expect(
      await failureOf(fhirGet({apiId: 'API-12', path: 'Patient/p1'})),
    ).toEqual({
      kind: 'rejected',
      apiId: 'API-12',
      status: 400,
      body: {
        format: 'rest-envelope',
        validationErrorCount: 1,
        internalErrorCount: 0,
      },
    });
  });

  it('when it answers 500 with an OperationOutcome, then the failure is a server error', async () => {
    server.use(
      http.get(URL_PATTERN, () =>
        HttpResponse.json(operationOutcome('exception'), {status: 500}),
      ),
    );

    expect(
      await failureOf(fhirGet({apiId: 'API-12', path: 'Patient/p1'})),
    ).toEqual({
      kind: 'server-error',
      apiId: 'API-12',
      status: 500,
      body: {format: 'operation-outcome', issueCodes: ['exception']},
    });
  });

  it('when it answers 502 with an HTML page, then the failure is a server error with an unrecognised body', async () => {
    server.use(
      http.get(URL_PATTERN, () =>
        HttpResponse.html('<html>Bad gateway</html>', {status: 502}),
      ),
    );

    expect(
      await failureOf(fhirGet({apiId: 'API-12', path: 'Patient/p1'})),
    ).toEqual({
      kind: 'server-error',
      apiId: 'API-12',
      status: 502,
      body: {format: 'unrecognised'},
    });
  });

  it('when the network fails, then the failure is a network error', async () => {
    server.use(http.get(URL_PATTERN, () => HttpResponse.error()));

    expect(
      await failureOf(fhirGet({apiId: 'API-12', path: 'Patient/p1'})),
    ).toEqual({kind: 'network-error', apiId: 'API-12'});
  });

  it('when a 200 body is not JSON, then the failure is a malformed response', async () => {
    server.use(
      http.get(URL_PATTERN, () => HttpResponse.html('<html>Sign in</html>')),
    );

    expect(
      await failureOf(fhirGet({apiId: 'API-12', path: 'Patient/p1'})),
    ).toMatchObject({kind: 'malformed-response', apiId: 'API-12', status: 200});
  });

  it('when the caller cancels, then the abort propagates as an abort, not as an API failure', async () => {
    server.use(
      http.get(URL_PATTERN, async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        return HttpResponse.json(patient());
      }),
    );
    const controller = new AbortController();
    const pending = fhirGet({
      apiId: 'API-12',
      path: 'Patient/p1',
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toMatchObject({name: 'AbortError'});
  });
});

describe('given an error body that carries patient data (NFR-SEC-6)', () => {
  it('when the error is raised, then neither its message nor its failure nor the console carries that data', async () => {
    const logged = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'info'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'error'),
      vi.spyOn(console, 'debug'),
    ];
    server.use(
      http.get(URL_PATTERN, () =>
        HttpResponse.json(restEnvelope(), {status: 400}),
      ),
      http.get('/bff/fhir/Patient/p2', () =>
        HttpResponse.json(operationOutcome('processing'), {status: 500}),
      ),
    );

    for (const path of ['Patient/p1', 'Patient/p2']) {
      let caught: unknown;
      try {
        await fhirGet({apiId: 'API-12', path});
      } catch (error) {
        caught = error;
      }
      if (!(caught instanceof ApiError)) throw new Error('expected ApiError');
      expect(caught.message).not.toContain(CANARY);
      expect(caught.message).toMatch(/^API-12 /);
      expect(JSON.stringify(caught.failure)).not.toContain(CANARY);
    }
    for (const spy of logged) expect(spy).not.toHaveBeenCalled();
  });
});
