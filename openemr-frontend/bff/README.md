# `bff/` — the token handler

The same-origin **token handler (BFF)** for the SPA ([PRD Q-7](../../REQUIREMENTS.md#q-7), option A): it
serves the built SPA and its own `/bff/*` routes from one origin
([FR-BFF-1…7](../../REQUIREMENTS.md#bff--token-handler); calls API-40…46 in
[`INTERFACES.md`](../../INTERFACES.md#11-transport--the-token-handler-bff)).
Node 22 + TypeScript on **Fastify 5**, Google TypeScript Style via `gts`; coding contract
[`CONVENTIONS.md`](../../CONVENTIONS.md).

> **Status: the keep-alive, the FHIR read proxy and the session lifecycle on sign-in and sign-out and the scaffold.** Serves
> the SPA, `/bff/health` and `/bff/ready` (API-45), sign-in (API-40, API-41), the session read (API-42),
> sign-out (API-43), the allow-listed FHIR reads (API-44) and the keep-alive (API-46), refreshes access tokens server-side and ends sessions
> at the inactivity timeout and the 10 h maximum, and puts the NFR-SEC-2 headers on every response.

| Path | What it does |
|---|---|
| `GET /` and client-side routes (`/signed-out`, …), `GET /index.html` | the SPA's `index.html`, `Cache-Control: no-store`: no browser or CDN keeps the page, and once a cookie has changed — sign-out deletes the session cookie — Chromium will not restore it from the back/forward cache (reason `response-cache-control-no-store`; with no cookie change Chromium may still restore a `no-store` page, which the SPA's `pageshow` reload covers — a separate change, [FR-AUTH-3](../../REQUIREMENTS.md#fr-auth-3)) and a deploy is seen on the next load; Railway's edge never stores a `no-store` response. The service worker's precache is Cache Storage, not the HTTP cache, so its install-time copy of `index.html` — the offline shell — is unaffected |
| `GET /assets/*` | Vite's fingerprinted build output, `public, max-age=31536000, immutable`. Nothing outside the build folder is reachable (`../`, `%2e%2e/`, `..%2f`, `..%5c`, `..\`), and dotfiles inside it (`.env`, `.git`) are 404s. Any other build file (outside `assets/`, not fingerprinted, not `index.html`) is `no-cache, max-age=0` (`max-age=0` pins Railway's edge TTL) |
| `GET /sw.js` | the SPA's service worker, written unhashed to the build root, so `Cache-Control: no-cache, max-age=0` like every unfingerprinted file (not `no-store`: it holds no PHI, and revalidating is enough) and a deploy is seen on the next update check; the CSP's `script-src 'self'` covers its registration (`worker-src` falls back to it) |
| `GET /manifest.webmanifest`, `GET /icons/*` | the PWA manifest (`application/manifest+json`) and icons (`image/png`) Vite copies from `public/` unhashed, so `Cache-Control: no-cache, max-age=0` like every unfingerprinted file; the CSP needs no new directive — `manifest-src` and `img-src` fall back to `default-src 'self'` ([FR-PWA-1](../../REQUIREMENTS.md#fr-pwa-1)) |
| `GET /bff/health` | liveness: `200 {"status":"ok","build":"<full commit sha>"}` (`BUILD_SHA`, or `unknown`), never touches OpenEMR. The full sha is the body in every environment, including production |
| `GET /bff/ready` | readiness: `200 {"status":"ready"}` when OpenEMR's SMART discovery (API-2) returns a SMART configuration, else `503 {"status":"not_ready","reason":…}` with `unreachable`, `timeout`, `upstream_status` or `invalid_discovery` — never FHIR `metadata` ([BUG-28](../../REQUIREMENTS.md#bug-28)). **Cached 5 s**: one answer, ready or not, is reused for 5 s from when it arrived — timed on the monotonic clock (`performance.now()`), so a wall-clock step neither stretches nor cuts the window — and probes that come while a check is in flight share it, so a probe storm reaches OpenEMR at most once per 5 s — and a change in OpenEMR (down or back up) shows here up to 5 s late |
| `POST /bff/login` (API-40) | the SPA's sign-in **form post**. CSRF-guarded (below). Reads discovery, stores `state`, `nonce` and the PKCE verifier server-side under a new **handshake cookie**, and `303`s to OpenEMR's authorize endpoint with `response_type=code`, the client id, `redirect_uri` = `<BFF_PUBLIC_ORIGIN>/bff/callback`, exactly the [§2 scopes](../../INTERFACES.md#2-scopes), `state`, `nonce`, `code_challenge` + `code_challenge_method=S256` ([BUG-16](../../REQUIREMENTS.md#bug-16)) and `aud` = SMART discovery's `issuer` ([BUG-17](../../REQUIREMENTS.md#bug-17)). Discovery unusable → `303 /signed-out?reason=signin_unavailable` |
| `GET /bff/callback` (API-41) | OpenEMR's redirect back — the registered `redirect_uri`. Takes the handshake **once** (deleted whatever happens, cookie cleared), checks `state` against it, exchanges the code (API-4, `client_secret_post`, with the verifier), validates the `id_token` (below), then sets the **session cookie** and `303`s to `/` — which never requires a session, because the new `Strict` cookie does not arrive on that cross-site-started hop ([API-41](../../INTERFACES.md#api-41)). Any failure `303`s to `/signed-out?reason=signin_failed` (OpenEMR said no, or something did not match) or `?reason=signin_unavailable` (OpenEMR could not be asked) with no session cookie |
| `POST /bff/logout` (API-43) | the SPA's sign-out **form post**. CSRF-guarded. Destroys the server-side session, clears the session cookie, and `303`s to OpenEMR's end-session endpoint (API-6) with `id_token_hint` and `post_logout_redirect_uri` = `<BFF_PUBLIC_ORIGIN>/signed-out` exactly ([BUG-5](../../REQUIREMENTS.md#bug-5)); with no session, straight to `/signed-out` (or `/signed-out?reason=idle` when that reason was posted). An optional urlencoded `reason=idle` (automatic logoff or privacy-screen grace) is validated (closed set); on the OpenEMR path it is stashed in a short-lived `bff-logout-reason` cookie (`SameSite=Lax`) for W-1b because the registered post-logout URI cannot carry a query; unknown values are ignored, and every path that does not set the cookie clears a lingering one; `signout_partial` still wins when discovery is down. If OpenEMR discovery is down, the local session is still destroyed but OpenEMR's cannot be ended: `303 /signed-out?reason=signout_partial`, so the app can say OpenEMR may still be signed in |
| `GET /bff/session` (API-42) | who is signed in and until when, for the session cookie: `200 {"authenticated":true,"user":{"displayName":…},"expiresAt":…,"idleTimeoutSeconds":…,"grantedScopes":[…]}`, or `401 {"error":"unauthenticated"}`. Not activity — *Session lifecycle* below |
| `POST /bff/session/activity` (API-46) | "Stay signed in" and the automatic keep-alive (FR-AUTH-4). CSRF-guarded like sign-in and sign-out; a same-origin `fetch` with no body (an empty form body is accepted too). Restarts the idle clock and answers `200 {"expiresAt":…}`, the new expiry — never past the 10 h maximum, nor past the access token's lapse when there is no refresh token. Never calls OpenEMR: no refresh, no patient data, never a token. No live session → `401 {"error":"unauthenticated"}`, and an ended one is never revived. *Session lifecycle* below |
| `GET /bff/fhir/{path}` (API-44) | the allow-listed FHIR read proxy — only the API-10…24 reads, with the session's bearer token attached here; OpenEMR's status and body pass through. Details below (*The FHIR read proxy, in detail*) |
| other methods on those six | `405` with `Allow: POST` (login, logout, session/activity) or `Allow: GET` (callback, session) — state changes are POST-only |
| other methods on `/bff/fhir/*` | `405 {"error":"method_not_allowed"}` with `Allow: GET` — reads only |
| any other `/bff/*`, any method | `404 {"error":"not_found"}`, never the SPA shell, never the disk. The namespace is judged on the percent-decoded, case-folded path with `\` and repeated `/` read as one `/`, so `/BFF/x`, `/bff%2fx`, `/%62ff/x`, `/bff;x/y`, `//bff/x` and `/bff%5cx` are 404s too, with `Cache-Control: no-store` |

**Every response** — files, `/bff/*` including the sign-in and sign-out redirects, 403s, 404s, 405s, 500s,
malformed-URL 400s, the `400`/`408`/`413`/`431` Node's HTTP parser answers before routing (bad request line, bad
`Content-Length`, headers not in by the request timeout, oversized chunk extensions, oversized headers), and the `503 {"error":"shutting_down"}` a request gets if it reaches the
router while the process drains after `SIGTERM` — carries
`Content-Security-Policy` (`default-src`, `script-src` and `connect-src 'self'`; `form-action 'self'` plus the
OpenEMR authorize origin, which sign-in's and sign-out's redirects need; `style-src 'self' 'unsafe-inline'` because
MUI's Emotion injects `<style>` at runtime — kept by decision, not a per-request nonce; NFR-SEC-2 says why; `base-uri 'self'`, `object-src 'none'`, `frame-ancestors 'none'`),
`Strict-Transport-Security: max-age=31536000`, `Referrer-Policy: same-origin` and `X-Content-Type-Options: nosniff`
([NFR-SEC-2](../../REQUIREMENTS.md#nfr-sec-2)); `/bff/*` adds `Cache-Control: no-store`. Logs carry
method, path (never the query string — the callback's carries the code and `state`; a `/bff/fhir/*` path is logged
as `/bff/fhir/{path}`, since it carries patient ids), status and latency
([FR-BFF-5](../../REQUIREMENTS.md#fr-bff-5)); a refused sign-in logs a reason code and at most an OAuth
error code or a claim *name* — never a token, the code, `state`, `nonce`, the verifier or the secret — and a session
that ends on its own logs only its reason (*Session lifecycle*), never a token or the session id.

**4xx reasons**: a 4xx the token handler answers itself — the routes', Fastify's, the error
handler's and the HTTP parser's alike — says what was wrong from a closed set, chosen by status alone:
`malformed_request` (400 only: a bad URL, request line, `Content-Length` or JSON body), `unauthenticated` (401),
`forbidden` (403), `not_found` (404), `method_not_allowed` (405), `request_timeout` (408), `too_large` (413 body or
chunk extensions, 414 URL, 431 headers), `unsupported_media_type` (415), `too_many_requests` (429, which no route
raises yet), and `client_error` for any other 4xx — which no path raises today, so the error handler also logs a
warning naming the status. The mapping is a typed table in `src/server.ts`, not a catch-all. The body is only
`{"error":"<reason>"}`: nothing of the request — path, query, header or body — is ever repeated back.

**Shutdown** (`SIGTERM`/`SIGINT`): idle keep-alive connections close at once, every response sent from then on
carries `Connection: close` (so an in-flight request finishes and its connection goes), and a connection the
HTTP parser refused is destroyed after its 400/408/413/431 — nothing holds `close()` open for a keep-alive timeout.

## Sign-in, in detail

**Discovery** is read, not built: SMART configuration (API-2 — authoritative for SMART,
[BUG-4](../../REQUIREMENTS.md#bug-4)) gives the authorize, token and JWKS endpoints, `S256`, the scope list
and the FHIR base used as `aud`; OpenID discovery (API-1) gives the `id_token` issuer and the end-session endpoint,
which SMART does not advertise. Both are fetched together and cached for an hour (a failure is not cached). Sign-in
is refused (`signin_unavailable`, logged with the reason) when SMART lacks `S256`, when its `scopes_supported` —
flattened first, since OpenEMR nests it one array deep ([BUG-42](../../REQUIREMENTS.md#bug-42)) — lacks a
scope we request ([BUG-11](../../REQUIREMENTS.md#bug-11); the log names the missing scopes), or when the
authorize or end-session endpoint is not on `OPENEMR_AUTHORIZE_ORIGIN` (CSP `form-action` would block the redirect).
A SMART document with no usable `scopes_supported` (missing, an object, a string) is refused too, never waved through.

**The `id_token`** is verified with [`jose`](https://github.com/panva/jose): RS256 only, signature against OpenEMR's
JWKS (API-7; an unknown `kid` or a bad signature fails), `iss` = OpenID discovery's issuer, `aud` = the client id,
`exp`, `iat` no older than 5 minutes (it is minted by the exchange just made), `sub`, and `nonce` equal to this
sign-in's — 60 s of clock skew allowed. A token-endpoint 5xx, network failure or timeout, or an unreachable JWKS, is
`signin_unavailable`; a 4xx (`invalid_grant` for a reused or expired code), a malformed token response or any claim
failure is `signin_failed`. Nothing from OpenEMR's response reaches the browser.

**Cookies** (FR-BFF-1) hold only opaque 256-bit random ids (`crypto.randomBytes`, base64url); a value of any other
shape is ignored unread. The PKCE verifier and the access and refresh tokens never reach the browser. `state`,
`nonce` and the PKCE challenge pass through the browser only where OAuth requires it: all three in the authorize
redirect, `state` (with the authorization code) in the callback redirect to `/bff/callback`, and the `nonce` inside
the `id_token` sent once as `id_token_hint` in the end-session redirect. None of them is stored in a cookie, web
storage or a log. The `id_token` crosses only inside the end-session URL, once, after the session is destroyed — [BUG-5](../../REQUIREMENTS.md#bug-5) makes it the
only way to end OpenEMR's own session ([NFR-SEC-1](../../REQUIREMENTS.md#nfr-sec-1)'s one exception). Our
`Referrer-Policy` cannot protect that URL: it is an OpenEMR document, so its `Referer` behaviour is OpenEMR's. It is
normally safe only because OpenEMR answers with a redirect straight to `/signed-out`; if it instead renders a page
(its 400, e.g. [BUG-5](../../REQUIREMENTS.md#bug-5)'s second-device case, or its plain-text 200), that
page's URL — `id_token_hint` included — is what OpenEMR's own referrer policy governs.

| Cookie | Attributes | Lifetime |
|---|---|---|
| `__Host-bff-handshake` | `HttpOnly; Secure; SameSite=Lax; Path=/`, no `Domain` — `Lax`, because OpenEMR's redirect back is a cross-site navigation that a `Strict` cookie would not ride | `Max-Age=600`, and the server-side record expires with it; set by API-40, read and deleted by API-41 only |
| `__Host-bff-session` | `HttpOnly; Secure; SameSite=Strict; Path=/`, no `Domain` | a browser-session cookie (no `Max-Age`); the server-side record ends at the inactivity timeout or the maximum session length, whichever comes first (*Session lifecycle*). A new sign-in replaces any existing session (a new id, the old record deleted) |

Because the session cookie is `Strict`, the `303 /` that ends a sign-in does not carry it (the chain began
cross-site); the SPA's own requests that follow do.

**CSRF** (FR-BFF-6): `POST /bff/login`, `POST /bff/logout` and `POST /bff/session/activity` run a guard before the body is read.
`Sec-Fetch-Site` decides when present — only `same-origin` passes (`same-site`, `cross-site` and `none` are 403);
without it, `Origin` must equal `BFF_PUBLIC_ORIGIN` exactly (`null` or absent is 403). A refusal is
`403 {"error":"forbidden"}`. All three accept an empty `application/x-www-form-urlencoded` body, which is what the SPA's
forms send; the keep-alive is a `fetch` with no body at all, whose `Origin` and `Sec-Fetch-Site` the browser sets.

**Server-side state** sits behind an async `ExpiringStore` interface (`src/session_store.ts`). Today it is
`MemoryStore`: **single instance only** — a second replica would not see the first's sessions, and a restart or
redeploy signs everyone out. Each store holds at most 10 000 entries (oldest evicted first), so unauthenticated
sign-in posts cannot grow memory without bound. Before running more than one instance, put a shared store (e.g.
Redis) behind the same interface, keyed by a hash of the cookie id so the store's contents alone cannot be replayed
as cookies, and encrypted at rest (FR-BFF-2). Sessions are only ever read and written through `SessionLifecycle`
(below), which a shared store must keep; its per-session ordering is in-process, so more than one instance also
needs a lock or a compare-and-set around the refresh.

**Sign-in rate limiting — at the edge, not here.** Anyone can post `/bff/login` in a loop, and each post stores a
handshake; past 10 000 the oldest in-flight handshakes are evicted, so a flood denies sign-in (nothing leaks — an
evicted handshake just fails its callback with `no_handshake`). The token handler does not rate-limit it, because
the cheap in-process versions do not help: behind the platform's proxy every request comes from the proxy's
address, so a per-client limit needs the client address from `X-Forwarded-For` and a trusted-hop setting only the
platform can vouch for (get it wrong and it throttles the whole clinic as one client, or trusts a spoofed header);
a global cap only turns eviction into refusal, the same denial; and per-process counters split across replicas.
Limit `POST /bff/login` per client IP, and in total, at the edge in front of the service — the platform's proxy,
CDN or WAF — where the real client address is known (from the review).

## Session lifecycle

`src/session_lifecycle.ts` ([FR-BFF-4](../../REQUIREMENTS.md#fr-bff-4)) owns every session read and write.

- **Limits.** A session ends at whichever comes first: **`BFF_IDLE_TIMEOUT_SECONDS`** (default 900, 15 min —
  [FR-AUTH-4](../../REQUIREMENTS.md#fr-auth-4)) after its last *authenticated request*, or
  **`BFF_MAX_SESSION_SECONDS`** (default 36 000, 10 h — [PRD Q-2](../../REQUIREMENTS.md#q-2)) after sign-in,
  however active and whatever the refresh token allows. Both are checked on every use, and the store's
  time-to-live mirrors the earlier, so an abandoned session is swept without being asked for. Ended means gone:
  the next request is a 401.
- **What counts as activity.** A request that uses the session's access token for the user — `getAccessToken(id)`,
  which the FHIR proxy (API-44) calls on every read, before it queues and again once it holds an upstream
  slot — sign-in itself, and the keep-alive
  (`POST /bff/session/activity`, API-46): `recordActivity(id)` restarts the idle clock and returns the new
  expiry (still capped by the maximum, and with no refresh token by the access token's lapse) without refreshing, so it never calls OpenEMR; it returns `undefined` — a 401 —
  for a session that has ended, and ends one whose access token has lapsed with no refresh token rather than keep it
  alive with nothing to act on. **`GET /bff/session` does
  not**: the SPA polls it, and a poll must not keep an unattended tablet signed in. So `expiresAt` does not move
  while the app only polls; the SPA's own inactivity timer (FR-AUTH-4: touch, key, scroll) is the one that sees the
  user, and this timeout is the server-side backstop behind it.
- **Refresh** ([API-5](../../INTERFACES.md#api-5)). Lazily, when `getAccessToken` finds the
  access token within **a minute** of expiry: `grant_type=refresh_token` as the confidential client
  (`client_secret_post`), with **no `scope`** — omitted means "as granted", whereas OpenEMR's echoed `scope` drops
  `api:` scopes and a refresh must repeat the original set exactly ([BUG-19](../../REQUIREMENTS.md#bug-19)).
  OpenEMR rotates the refresh token and revokes the old one, so two refreshes at once would invalidate each other:
  each session's operations run **one at a time**, so concurrent requests wait for the one refresh and share its
  token, and a sign-out during a refresh is not undone by it. The rotated refresh token replaces the old one; the
  new `id_token` a refresh returns is ignored, because sign-out's `id_token_hint` must be the sign-in one, whose
  `nonce` OpenEMR matches ([BUG-5](../../REQUIREMENTS.md#bug-5)).
- **A failed refresh ends the session**, whatever the cause, and logs `session ended: refresh failed` with a
  reason — `refresh_rejected` (OpenEMR said no; `detail` is its OAuth error code, e.g. `invalid_grant`),
  `refresh_unavailable` (unreachable, timeout, 5xx or discovery down) or `refresh_invalid_response` — never a
  token, the session id or a response body. Without `offline_access` there is no refresh token: the access token
  serves until it lapses, then the session ends (`access_token_expired`) — on any use, the API-42 poll included — and
  `expiresAt` is never later than that lapse. Idle and maximum endings log
  `idle_timeout` / `max_session` when a request finds them.
- **`/bff/session`** ([API-42](../../INTERFACES.md#api-42), `src/session_route.ts`) answers
  `displayName` — the clinician's own name, looked up once per session from the `id_token`'s `fhirUser`
  Practitioner (API-18, `src/display_name.ts`) with the session's bearer, and only when `fhirUser` is a
  Practitioner on the FHIR base; `null` if OpenEMR refuses it (e.g. without `admin/users`,
  [BUG-10](../../REQUIREMENTS.md#bug-10)), and asked again on the next read only if OpenEMR was
  unreachable — plus `expiresAt` (ISO 8601, the earlier of the two limits — and of the access token's lapse, with no refresh token), `idleTimeoutSeconds` and
  `grantedScopes` (API-4's `scope`, which omits `api:` scopes). Never a token, no patient data;
  `Cache-Control: no-store` like all of `/bff/*`.
- **For a route that acts for the user** (the FHIR proxy, is one). `app.sessions` is the lifecycle, and `sessionIdOf(request, config.cookieMode)`
  (`src/session_cookie.ts`) reads the session cookie. `await app.sessions.getAccessToken(id)` returns the bearer —
  refreshed if due, and counting as activity — or `undefined`, which means answer 401. Pass `{activity: false}`
  only for a call the user did not make.

## The FHIR read proxy, in detail

`GET /bff/fhir/{path}` (API-44, [FR-BFF-3](../../REQUIREMENTS.md#fr-bff-3),
[FR-BFF-5](../../REQUIREMENTS.md#fr-bff-5)) is how every card reads. In order, a request is:

1. **405** unless it is `GET` (`HEAD` included), before any body is read.
2. **404 `{"error":"not_found"}`**, OpenEMR never contacted, unless it matches one row of the allow-list
   (`src/fhir_allow_list.ts`) **exactly**. Each row is an [inventory](../../INTERFACES.md#4-data-calls--p0)
   read — API-10…24 — written out as a resource name, `read` (`{Resource}/{id}`, no query) or `search`, and the
   query parameters it may carry, each with a value rule: FHIR ids (`[A-Za-z0-9.-]{1,64}`, not `.`/`..`), fixed
   values that tell rows sharing a path apart (`category=vital-signs` API-21, `laboratory` API-22), `date=ge{YYYY-MM-DD}`, and the listed optional filters (`status`, API-11's
   `name` / `birthdate` / `identifier` / `_count` / `_offset`, API-18's `_id` batch). The path is judged on the
   **raw request target** before anything decodes it: only letters, digits, `.`, `-` and one `/` between resource
   and id — so `..`, `%2e%2e`, `%2f`, `%5c`, `\`, `;`, `//`, a trailing `/` and any other percent-escape never match.
   A parameter off the row, repeated, or empty never matches either. Nothing is derived from the request: the
   forwarded path and query are rebuilt from the validated parts.
   **MedicationRequest is one row, `API-15/16`**: `MedicationRequest?patient={id}` with no `intent` and no
   `status`. The Medications card (API-15) and the Prescriptions card (API-16) both read every intent, since `intent`
   cannot tell a medication-list entry from a prescription (maintainer rulings), so one request
   serves both: the SPA sends it once per chart load and each card picks its own rows. The proxy cannot name
   one card, so it does not guess: it logs and counts the read, once, as `API-15/16`. The old `intent=plan` and `intent=order` forms are refused (404), since no card sends them.
   **API-22 is the Labs card's read and nothing wider**: `Observation?patient={id}&category=laboratory&date=ge{YYYY-MM-DD}`,
   each once — no `code` (the card shows every test), no paging or sort, and never without `date`, since an undated lab
   search returns the whole history ([BUG-36](../../REQUIREMENTS.md#bug-36)).
3. **403 `{"error":"forbidden"}`** if the browser says the request is not same-origin (`Sec-Fetch-Site` present and
   not `same-origin`). FR-BFF-6's `POST` guard is not applied: a read changes nothing, and the SPA's same-origin
   `fetch` sends no `Origin`. Without `Sec-Fetch-Site` (Bruno, curl) the `SameSite=Strict` session cookie is the
   defence, as it is for any cross-site request.
4. **401 `{"error":"unauthenticated"}`** — what the SPA treats as session-over — with no session cookie, an unknown
   one, or a session the lifecycle has ended (idle, maximum length, failed refresh — *Session lifecycle* above). The
   id comes from `sessionIdOf` and the bearer from `app.sessions.getAccessToken(id)`, which refreshes a token inside
   its margin and counts the read as activity, so reading a chart keeps the session alive. It is asked twice: before
   the read queues (no live session, no place in the queue) and again once the read holds an upstream slot, and the
   second answer is the bearer sent — so a queue wait longer than the one-minute refresh margin, possible when
   `BFF_FHIR_TIMEOUT_MS` is raised, never sends a token that lapsed while it waited, and a session that ended
   meanwhile is a 401 with nothing forwarded.
5. **Forwarded** to `{OPENEMR_BASE_URL}/apis/{OPENEMR_SITE}/fhir` — from configuration, never from a discovery
   document, so nothing remote can choose where the bearer goes — with exactly two headers: `Authorization: Bearer`
   from the server-side session and `Accept` (the client's if it is `application/fhir+json` or `application/json`,
   else `application/fhir+json`). The client's `Authorization`, cookies and every other header are dropped.
   Redirects are refused, never followed (`redirect: 'error'`), so a 3xx cannot carry the token elsewhere.

**Answers.** OpenEMR's status and body pass through unchanged — `OperationOutcome` and the REST envelope alike
([BUG-33](../../REQUIREMENTS.md#bug-33)). None of its headers do except a JSON `Content-Type`
(`application/fhir+json` or `application/json`); any other body (a PHP error page) goes out as `text/plain`, never
rendered as HTML on this origin. `Set-Cookie`, `ETag`, caching and CORS headers are dropped; every answer, the
proxy's own errors included, carries `Cache-Control: no-store` and the NFR-SEC-2 headers. The body is held **in
memory only**, up to 16 MiB (more is refused), and never cached or written to disk — the proxy modules import
nothing that can touch the file system, and a test holds them to it.

**Slow FHIR** ([BUG-28](../../REQUIREMENTS.md#bug-28)): at most `BFF_FHIR_MAX_CONCURRENT` (default 4)
reads go to OpenEMR at once, and at most `BFF_FHIR_MAX_CONCURRENT_PER_SESSION` (default 3) for one session, so one
dashboard's fan-out cannot hold every slot while another clinician waits. The rest queue first-come — up to 256 in all and
32 for any one session; past either, `503 {"error":"busy"}`, so one session flooding the queue gets the 503s, not
everyone else. Each read has one budget, `BFF_FHIR_TIMEOUT_MS` (default 30 s), queue wait included:
past it, `504 {"error":"upstream_timeout"}`. OpenEMR unreachable, a redirect, or an answer over 16 MiB (the read stops at the cap, it never buffers past it):
`502 {"error":"upstream_unavailable"}`. None of these bodies carries anything from the request.

**Logs and counters.** One line per request, `fhir proxy`, carrying `method`, `api` (the `API-#`, or `none`),
`status` and `latencyMs` — never the path, the query string, a body or a token; Fastify's own request lines log the
path as `/bff/fhir/{path}`, an absolute-form target (`GET http://host/bff/fhir/…`) included. `FhirProxyMetrics` counts each forwarded read per `API-#` (a MedicationRequest read, one per chart load for both cards, under `API-15/16`) by outcome — `ok`,
`empty_bundle` (a search `Bundle` with no `entry`; only answers up to 64 KiB are parsed for this — an empty Bundle is a few hundred bytes, and a large answer passes through unparsed), `unauthorized` (401), `forbidden` (403), `client_error`,
`server_error`, `timeout`, `upstream_unavailable`, `busy` — so a 401, a 403 or an empty result is never hidden
inside "no errors" ([BUG-38](../../REQUIREMENTS.md#bug-38)); requests answered without contacting
OpenEMR are counted by reason (`not_allow_listed`, `method_not_allowed`, `cross_site`, `no_session`). The counters
live in memory; there is no metrics endpoint yet.

## Configuration

Environment only, parsed once at start-up (`src/config.ts`); a bad value stops the process before it listens,
listing every problem by variable and rule, never by value. Every variable, its default and its rule:
[`.env.example`](.env.example). Required: `BFF_SPA_DIST_DIR`, `OPENEMR_BASE_URL`, `BFF_PUBLIC_ORIGIN`,
`OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`. The FHIR proxy's timeout and concurrency caps (`BFF_FHIR_TIMEOUT_MS`,
`BFF_FHIR_MAX_CONCURRENT`, `BFF_FHIR_MAX_CONCURRENT_PER_SESSION`) have defaults sized for
[BUG-28](../../REQUIREMENTS.md#bug-28); the per-session cap may not exceed the global one.

**OAuth client.** Registered per environment by `npm run oauth:register`
([runbook](../../DEPLOYMENT.md)), for the redirect and post-logout URIs built on
`BFF_PUBLIC_ORIGIN` — change the origin and the client must be registered again.

- `OAUTH_CLIENT_ID` — the environment's `clientId` in [`../config/oauth-clients.json`](../config/oauth-clients.json)
  where one is recorded (staging, production); a workstation's own id otherwise (`local` is never recorded).
- `OAUTH_CLIENT_SECRET` — **server-side environment only**: the platform's secret variable for the deployed service
  (on staging, a Railway variable on the token handler's service), an untracked env file on a workstation. Never in
  git, a `VITE_*` variable, the SPA bundle or a log. It is held in a `Secret` that prints `[redacted]` in JSON,
  `util.inspect` and string conversion; start-up errors name the variable, never its value.

The client must hold **`offline_access`** (in the [§2 list](../../INTERFACES.md#2-scopes)) or
OpenEMR issues no refresh token and every session ends with its first access token, about an hour in; a client
registered without it cannot be updated, only replaced ([runbook](../../DEPLOYMENT.md#re-running-safely)).

**Session limits.** `BFF_IDLE_TIMEOUT_SECONDS` (default 900) and `BFF_MAX_SESSION_SECONDS` (default 36 000) —
*Session lifecycle* above; start-up refuses an idle timeout longer than the maximum.

## Local development

The `local` entry in `config/oauth-clients.json` registers `frontendOrigin` `http://localhost:5173`, the **Vite dev
server** — so that is the origin the browser uses, and Vite proxies `/bff/*` to this service on `:8080`
(`../vite.config.ts`, `server.proxy`, Host and Origin passed through). Two things follow:

- `BFF_PUBLIC_ORIGIN=http://localhost:5173`, so the redirect URIs match the registration and the CSRF guard's
  `Origin` fallback matches the browser.
- `__Host-` cookies need `Secure`, which plain http cannot carry, so a plain-http origin requires
  **`BFF_DEV_INSECURE_COOKIES=true`**: the cookies are named `bff-handshake` / `bff-session` and drop `Secure`;
  `HttpOnly`, `SameSite` and `Path=/` stay. Start-up **refuses** the flag with an https origin, with a non-loopback
  origin, and whenever `NODE_ENV=production`, and refuses a plain-http origin without it — so a deployed
  environment cannot fall back to it.

```bash
# openemr-frontend/: the SPA on :5173, proxying /bff/*
npm run dev
# openemr-frontend/bff/, another terminal, after building the SPA once (npm run build in openemr-frontend/)
npm ci && npm run build
PORT=8080 BFF_SPA_DIST_DIR=../dist OPENEMR_BASE_URL=https://localhost:9300 \
  BFF_PUBLIC_ORIGIN=http://localhost:5173 BFF_DEV_INSECURE_COOKIES=true \
  OAUTH_CLIENT_ID=<your local client id> OAUTH_CLIENT_SECRET=<from your untracked env file> \
  NODE_EXTRA_CA_CERTS=~/openemr-dev-stack.pem npm start
```

`NODE_EXTRA_CA_CERTS` trusts the dev stack's self-signed certificate without turning verification off — the
[runbook](../../DEPLOYMENT.md#the-local-dev-stack) says how to save it; never
`NODE_TLS_REJECT_UNAUTHORIZED=0`.

## Run it

From `openemr-frontend/bff/` (Node 22+), after building the SPA (`npm run build` in `openemr-frontend/`), with the
variables above exported (a deployed environment uses its https origin and no development flag):

```bash
npm ci
npm run build
npm start
```

In a container — the deployable, [`../Dockerfile`](../Dockerfile) (non-root, no npm or yarn, SPA baked in at `/app/public`,
`HEALTHCHECK` on `/bff/health`, nothing secret baked in), from the repo root:

```bash
docker build -t openemr-frontend:local openemr-frontend
docker run --rm -p 8080:8080 \
  -e OPENEMR_BASE_URL=https://openemr.example.test \
  -e BFF_PUBLIC_ORIGIN=https://frontend.example.test \
  -e OAUTH_CLIENT_ID=synthetic-client-id \
  -e OAUTH_CLIENT_SECRET=replace-with-the-registered-secret \
  openemr-frontend:local
```

`/bff/health` on the running container answers `{"status":"ok","build":…}`. Deployment, its variables and the
cache headers the CDN relies on: [`DEPLOYMENT.md`](../../DEPLOYMENT.md).

Local gates, the same commands the token handler's CI checks run:
`npm run lint` · `npm run typecheck` · `npm run format:check` · `npm test` · `npm run build`. Tests are Vitest
against `fastify.inject()` (no listening socket) with OpenEMR faked by MSW — for sign-in, a stub authorization
server (`src/test/stub_openemr.ts`) with its own RS256 key generated per test run, and a stub FHIR server that
records every request it receives and answers with synthetic PHI the log tests look for. No real network, no real OpenEMR.
This package's `npm audit` (high+) and production-licence checks run from the SPA's directory, over both lockfiles:
`npm run deps:audit` / `npm run deps:licences` there, the same in CI.
