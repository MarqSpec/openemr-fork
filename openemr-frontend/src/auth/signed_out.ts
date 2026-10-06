import type {Notice} from './notice';

// Where the token handler sends the browser after sign-out, or after a sign-in it could not complete, with an
// optional `reason` (query, or a short-lived cookie when OpenEMR end-session forbids a query on the registered URI —
// BUG-5). Each known code maps to fixed text; anything else is the generic notice, so the value is never rendered.
// a separate change (note 86739) · INTERFACES.md API-40, API-41, API-43

const SIGNED_OUT_PATH = /^\/signed-out\/?$/;

/** Must match the BFF's `LOGOUT_REASON_COOKIE` (auth_routes.ts). */
const LOGOUT_REASON_COOKIE = 'bff-logout-reason';

const GENERIC: Notice = {
  severity: 'info',
  title: "You're signed out",
  body: 'Patient data has been cleared from this tablet. Sign in again to continue.',
};

const BY_REASON: ReadonlyMap<string, Notice> = new Map([
  [
    'signin_failed',
    {
      severity: 'error',
      title: "Sign-in didn't complete",
      body: "OpenEMR didn't confirm your sign-in. Try again, and if it keeps happening, contact your administrator.",
    },
  ],
  [
    'signin_unavailable',
    {
      severity: 'error',
      title: 'Sign-in is unavailable',
      body: "OpenEMR couldn't be reached to sign you in. Try again in a few minutes.",
    },
  ],
  [
    'signout_partial',
    {
      severity: 'warning',
      title: 'OpenEMR may still be signed in',
      body: "You're signed out of the Patient Dashboard and its patient data is cleared, but OpenEMR couldn't be reached to end your OpenEMR session. Sign out of OpenEMR too, or close the browser.",
    },
  ],
  [
    'idle',
    {
      severity: 'info',
      title: 'Signed out for inactivity',
      body: 'You were signed out after a period of inactivity. Patient data has been cleared from this tablet. Sign in again to continue.',
    },
  ],
]);

/** True for the token handler's post-sign-out landing page (`post_logout_redirect_uri`). */
export function isSignedOutPath(pathname: string): boolean {
  return SIGNED_OUT_PATH.test(pathname);
}

// Read raw, never decoded: the BFF only writes `idle`, and a malformed escape must not throw and blank W-1b.
function consumeLogoutReasonCookie(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const prefix = `${LOGOUT_REASON_COOKIE}=`;
  const entry = document.cookie
    .split('; ')
    .find(part => part.startsWith(prefix));
  if (entry === undefined) return undefined;
  document.cookie = `${LOGOUT_REASON_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax`;
  return entry.slice(prefix.length);
}

/** The notice for a `/signed-out` landing: a known `reason` from the query or logout cookie, else generic. */
export function signedOutNotice(search: string): Notice {
  // Always consumed, so a lingering cookie cannot label a later sign-out.
  const cookieReason = consumeLogoutReasonCookie();
  const reason = new URLSearchParams(search).get('reason') ?? cookieReason;
  return (reason === undefined ? undefined : BY_REASON.get(reason)) ?? GENERIC;
}
