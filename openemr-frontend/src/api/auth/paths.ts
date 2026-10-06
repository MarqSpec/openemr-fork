// The token handler's sign-in, sign-out and session routes, same origin as the SPA.
// reference: INTERFACES.md API-40, API-42, API-43, API-46

/** API-40: sign-in. A top-level form post, never `fetch` — the CSRF guard admits only same-origin navigations. */
export const BFF_LOGIN_PATH = '/bff/login';
/** API-43: sign-out, the same way; the token handler then sends the browser to OpenEMR's end-session. */
export const BFF_LOGOUT_PATH = '/bff/logout';
/** API-42: who is signed in. Reading it is not activity on the server. */
export const BFF_SESSION_PATH = '/bff/session';
/** API-46: "Stay signed in" — a `fetch` POST the token handler counts as activity, without calling OpenEMR. */
export const BFF_SESSION_ACTIVITY_PATH = '/bff/session/activity';
