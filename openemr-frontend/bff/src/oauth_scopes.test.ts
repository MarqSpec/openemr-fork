import {describe, expect, it} from 'vitest';
import {OAUTH_SCOPES} from './oauth_scopes.js';
import {REQUESTED_SCOPES} from './test/stub_openemr.js';

describe('given the scopes the token handler requests at sign-in', () => {
  it('when compared with config/oauth-scopes.json (the machine copy of SERVER_API_INVENTORY §2), then they are exactly that list, in order', () => {
    expect(OAUTH_SCOPES).toEqual(REQUESTED_SCOPES);
  });

  it('when read, then identity, the FHIR gate and offline access are all present (FR-AUTH-2, BUG-21, BUG-19)', () => {
    for (const scope of ['openid', 'fhirUser', 'api:fhir', 'offline_access']) {
      expect(OAUTH_SCOPES).toContain(scope);
    }
  });

  it('when read, then every resource scope is SMART v1 read-only (NFR-SEC-4, BUG-11)', () => {
    for (const scope of OAUTH_SCOPES.filter(s => s.includes('/'))) {
      expect(scope).toMatch(/^user\/[A-Z][A-Za-z]+\.read$/);
    }
  });
});
