import {afterEach, describe, expect, it} from 'vitest';

import {isSignedOutPath, signedOutNotice} from './signed_out';

// a separate change (note 86739) · INTERFACES.md API-40, API-41, API-43 · REQUIREMENTS.md FR-AUTH-3

const GENERIC = signedOutNotice('');

const IDLE_TITLE = 'Signed out for inactivity';

afterEach(() => {
  document.cookie = 'bff-logout-reason=; Max-Age=0; Path=/';
});

describe('given the token handler sent the browser to /signed-out', () => {
  it('when there is no reason, then the notice says the user is signed out and patient data is cleared', () => {
    expect(GENERIC).toEqual({
      severity: 'info',
      title: "You're signed out",
      body: 'Patient data has been cleared from this tablet. Sign in again to continue.',
    });
  });

  it('when the reason is signin_failed, then the notice says sign-in did not complete', () => {
    expect(signedOutNotice('?reason=signin_failed')).toEqual({
      severity: 'error',
      title: "Sign-in didn't complete",
      body: "OpenEMR didn't confirm your sign-in. Try again, and if it keeps happening, contact your administrator.",
    });
  });

  it('when the reason is signin_unavailable, then the notice says OpenEMR could not be reached', () => {
    expect(signedOutNotice('?reason=signin_unavailable')).toEqual({
      severity: 'error',
      title: 'Sign-in is unavailable',
      body: "OpenEMR couldn't be reached to sign you in. Try again in a few minutes.",
    });
  });

  it('when the reason is idle, then the notice says the user was signed out for inactivity', () => {
    expect(signedOutNotice('?reason=idle')).toEqual({
      severity: 'info',
      title: 'Signed out for inactivity',
      body: 'You were signed out after a period of inactivity. Patient data has been cleared from this tablet. Sign in again to continue.',
    });
  });

  it('when there is no query but the logout-reason cookie is idle, then the inactivity notice shows and the cookie is cleared (BUG-5)', () => {
    document.cookie = 'bff-logout-reason=idle; Path=/; SameSite=Strict';

    expect(signedOutNotice('')).toEqual({
      severity: 'info',
      title: 'Signed out for inactivity',
      body: 'You were signed out after a period of inactivity. Patient data has been cleared from this tablet. Sign in again to continue.',
    });
    expect(document.cookie).not.toContain('bff-logout-reason=');
  });

  it.each([
    ['malformed percent-encoding', '%E0'],
    ['an unknown code', 'something_new'],
    ['a percent-encoded known code', '%69dle'],
    ['markup', '%3Cb%3EZzreflected%3C%2Fb%3E'],
  ])(
    'when there is no query and the logout-reason cookie holds %s, then the generic notice shows, nothing throws and the cookie is cleared',
    (_label, value) => {
      document.cookie = `bff-logout-reason=${value}; Path=/`;

      expect(signedOutNotice('')).toEqual(GENERIC);
      expect(document.cookie).not.toContain('bff-logout-reason=');
    },
  );

  it('when the query carries a reason and an idle logout-reason cookie lingers, then the query wins and the cookie is cleared, so a later sign-out is not labelled inactivity', () => {
    document.cookie = 'bff-logout-reason=idle; Path=/';

    expect(signedOutNotice('?reason=signout_partial').title).toBe(
      'OpenEMR may still be signed in',
    );
    expect(document.cookie).not.toContain('bff-logout-reason=');
    expect(signedOutNotice('').title).not.toBe(IDLE_TITLE);
  });

  it('when the reason is signout_partial, then the notice warns that OpenEMR may still be signed in', () => {
    expect(signedOutNotice('?reason=signout_partial')).toEqual({
      severity: 'warning',
      title: 'OpenEMR may still be signed in',
      body: "You're signed out of the Patient Dashboard and its patient data is cleared, but OpenEMR couldn't be reached to end your OpenEMR session. Sign out of OpenEMR too, or close the browser.",
    });
  });

  it.each([
    ['an unknown code', '?reason=something_new'],
    ['markup', '?reason=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E'],
    ['a name', '?reason=Dr.%20Avery%20Demo'],
    ['an Object prototype key', '?reason=constructor'],
    ['another prototype key', '?reason=__proto__'],
    ['an empty value', '?reason='],
    ['a case variant of a known code', '?reason=SIGNIN_FAILED'],
  ])(
    'when the reason is %s, then the generic notice is shown and the value is never reflected',
    (_label, search) => {
      const notice = signedOutNotice(search);
      expect(notice).toEqual(GENERIC);
      const reason = new URLSearchParams(search).get('reason') ?? '';
      if (reason.length > 0) {
        expect(JSON.stringify(notice)).not.toContain(reason);
      }
    },
  );

  it('when the reason is repeated, then only the first one counts', () => {
    expect(
      signedOutNotice('?reason=signout_partial&reason=signin_failed'),
    ).toEqual(signedOutNotice('?reason=signout_partial'));
  });
});

describe('given a URL path', () => {
  it.each([
    ['/signed-out', true],
    ['/signed-out/', true],
    ['/', false],
    ['/signed-out/extra', false],
    ['/patient/signed-out', false],
  ])('when it is %s, then it is the signed-out page: %s', (path, expected) => {
    expect(isSignedOutPath(path)).toBe(expected);
  });
});
