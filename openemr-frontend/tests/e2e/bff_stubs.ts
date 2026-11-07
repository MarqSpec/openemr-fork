import type {Page, Request} from '@playwright/test';

// Local tier (no backend): layout-only stubs of the token handler. They pick which screen the SPA draws — signed
// in or not — and catch the sign-in and sign-out form posts so a spec can check what the browser sent. They prove
// nothing about the token handler itself; real sign-in and sign-out are the staging spec's
// (staging/sign_in.spec.ts). reference: CONVENTIONS.md (Two tiers), INTERFACES.md API-40, API-42, API-43,
// API-48

/** A synthetic clinician, as API-42 names them. */
export const CLINICIAN = 'Dr. Avery Demo';

/** What `/bff/config` (API-48) answers: the token handler's PATIENT_APPS and PRIVACY_GRACE_SECONDS, parsed. */
export interface RuntimeConfig {
  readonly patientApps: readonly {
    readonly label: string;
    readonly url: string;
    readonly aclHint?: string;
  }[];
  readonly privacyGraceSeconds: number;
}

/** A token handler with neither variable set: no Patient apps slot, the 60 s grace. */
export const UNCONFIGURED: RuntimeConfig = {
  patientApps: [],
  privacyGraceSeconds: 60,
};

/**
 * `/bff/config` answers `config`. The SPA waits for it beside `/bff/session` before it draws anything signed in
 * so every signed-in spec needs it; a spec about the config passes its own.
 */
export async function stubRuntimeConfig(
  page: Page,
  config: RuntimeConfig = UNCONFIGURED,
): Promise<void> {
  await page.route('**/bff/config', route =>
    route.fulfill({status: 200, json: config}),
  );
}

/** `/bff/session` answers 401: nobody is signed in, so the SPA shows W-1. */
export async function stubSignedOut(page: Page): Promise<void> {
  await stubRuntimeConfig(page);
  await page.route('**/bff/session', route =>
    route.fulfill({status: 401, json: {error: 'unauthenticated'}}),
  );
}

/** `/bff/session` answers 200 for {@link CLINICIAN}, and `/bff/config` answers `config`. */
export async function stubSignedIn(
  page: Page,
  config: RuntimeConfig = UNCONFIGURED,
): Promise<void> {
  await stubRuntimeConfig(page, config);
  await page.route('**/bff/session', route =>
    route.fulfill({
      status: 200,
      json: {
        authenticated: true,
        user: {displayName: CLINICIAN},
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        idleTimeoutSeconds: 900,
        grantedScopes: ['openid', 'fhirUser'],
      },
    }),
  );
}

/** What the browser sent to a form-post route, captured instead of reaching a token handler. */
export interface CapturedPost {
  readonly method: string;
  readonly isNavigation: boolean;
  readonly contentType: string | undefined;
  readonly body: string;
  readonly authorization: string | undefined;
}

/** Catches the next request to `path` and answers it with a blank page, recording what was sent. */
export async function capturePost(
  page: Page,
  path: '/bff/login' | '/bff/logout',
): Promise<() => CapturedPost | undefined> {
  let captured: CapturedPost | undefined;
  await page.route(`**${path}`, async route => {
    const request: Request = route.request();
    const headers = await request.allHeaders();
    captured = {
      method: request.method(),
      isNavigation: request.isNavigationRequest(),
      contentType: headers['content-type'],
      body: request.postData() ?? '',
      authorization: headers.authorization,
    };
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><title>stub</title>',
    });
  });
  return () => captured;
}

/** A synthetic Patient as API-11 returns it; obviously fake. */
function syntheticPatient(n: number): Record<string, unknown> {
  const id = `test-patient-${String(n).padStart(4, '0')}`;
  return {
    resourceType: 'Patient',
    id,
    name: [
      {use: 'official', family: 'Testperson', given: [`Fakey${String(n)}`]},
    ],
    gender: n % 2 === 0 ? 'female' : 'male',
    birthDate: '1970-01-01',
    identifier: [
      {
        type: {
          coding: [
            {
              system: 'http://terminology.hl7.org/CodeSystem/v2-0203',
              code: 'PT',
            },
          ],
        },
        value: `TEST-MRN-${String(n).padStart(4, '0')}`,
      },
    ],
  };
}

/**
 * `/bff/fhir/Patient` (API-11) answers `count` synthetic patients, sliced by `_count`/`_offset` — layout only: it
 * gives the search screen rows and pages to draw. A chart opened from it reads the same synthetic patient by id
 * (API-12) and every card's search answers an empty Bundle, so the header can name the patient. Whether
 * OpenEMR matches, pages and reads is the staging spec's.
 */
export async function stubPatientSearch(
  page: Page,
  count: number,
): Promise<void> {
  // Playwright tries the newest route first, so the catch-all goes in before the two Patient routes.
  await page.route('**/bff/fhir/**', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/fhir+json',
      json: {resourceType: 'Bundle', type: 'searchset', total: 0, entry: []},
    }),
  );
  await page.route('**/bff/fhir/Patient/*', route => {
    const id = new URL(route.request().url()).pathname.split('/').pop() ?? '';
    const n = Number(/^test-patient-(\d{4})$/.exec(id)?.[1] ?? 'NaN');
    return Number.isInteger(n) && n >= 1 && n <= count
      ? route.fulfill({
          status: 200,
          contentType: 'application/fhir+json',
          json: syntheticPatient(n),
        })
      : route.fulfill({
          status: 404,
          contentType: 'application/fhir+json',
          json: {
            resourceType: 'OperationOutcome',
            issue: [{severity: 'error', code: 'not-found'}],
          },
        });
  });
  await page.route('**/bff/fhir/Patient?*', route => {
    const query = new URL(route.request().url()).searchParams;
    const offset = Number(query.get('_offset') ?? '0');
    const pageSize = Number(query.get('_count') ?? '20');
    const entries = Array.from({length: count}, (_, n) =>
      syntheticPatient(n + 1),
    )
      .slice(offset, offset + pageSize)
      .map(resource => ({resource}));
    return route.fulfill({
      status: 200,
      contentType: 'application/fhir+json',
      json: {
        resourceType: 'Bundle',
        type: 'collection',
        total: entries.length,
        entry: entries,
      },
    });
  });
}
