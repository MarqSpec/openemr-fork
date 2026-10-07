# Interfaces

Every server call the patient-dashboard frontend makes, by `API-` id — the calls the browser makes to its token
handler (API-40…47) and the calls the token handler makes to OpenEMR (API-1…24). The typed API layer
(`openemr-frontend/src/api/`) and the token handler's allow-list (`openemr-frontend/bff/src/fhir_allow_list.ts`)
implement exactly these rows and nothing else ([NFR-CON-2](REQUIREMENTS.md#nfr-con-2)). Requirement and defect IDs
(`FR-`, `NFR-`, `BUG-`) are in [REQUIREMENTS.md](REQUIREMENTS.md). OpenEMR's own complete API is documented upstream
in [`Documentation/api/`](Documentation/api/README.md) and [`swagger/openemr-api.yaml`](swagger/openemr-api.yaml).

## 1. Base URLs and conventions

| Surface | Base |
|---|---|
| OAuth2 / OpenID Connect | `{openemr}/oauth2/{site}` |
| FHIR R4 (US Core) | `{openemr}/apis/{site}/fhir` |
| Standard REST | `{openemr}/apis/{site}/api` |

- `{site}` is OpenEMR's site id, `default` unless the installation is multi-site (`OPENEMR_SITE`).
- Data calls send `Authorization: Bearer <access token>` and `Accept: application/fhir+json`.
- FHIR searches answer a `Bundle` with **no `next` link, and `total` equal to the entries returned**
  ([BUG-7](REQUIREMENTS.md#bug-7)); errors are `OperationOutcome`, except some 400s that carry the REST envelope
  ([BUG-33](REQUIREMENTS.md#bug-33)).
- **Dates are wall-clock values, not instants:** OpenEMR stamps a stored local date or time with the server's
  current offset ([BUG-51](REQUIREMENTS.md#bug-51)), so the app reads dates and times as written and never converts
  them through the device's time zone (`src/api/openemr_date.ts`).
- FHIR identifies a patient by its **UUID**; the numeric `pid` is never needed.

### 1.1 Transport — the token handler (BFF)

OpenEMR refuses `user/` scopes to public clients ([BUG-1](REQUIREMENTS.md#bug-1)), so the browser never calls
OpenEMR's APIs itself. The token handler serves the SPA and `/bff/*` from one origin, holds a confidential client and
every token, and proxies an allow-list of FHIR reads:

```
 tablet (SPA) ──(A) same-origin /bff/*, HttpOnly cookie──► token handler ──(B) bearer token──► OpenEMR
                                                                           API-1…API-24 (§3–§5)
 tablet ──top-level navigation only──► OpenEMR /oauth2/{site}/authorize (login and consent)
```

**(A) Browser → token handler** — the only calls the browser code makes:

| ID | Method · path | Purpose |
|---|---|---|
| **API-40**<a id="api-40"></a> | `POST /bff/login` (a top-level form post; CSRF-checked) | Start sign-in: store the PKCE verifier, `state` and `nonce` server-side under the handshake cookie, then `303` to OpenEMR's authorize endpoint (API-3) |
| **API-41**<a id="api-41"></a> | `GET /bff/callback?code&state` (the registered redirect URI) | Take the handshake once, check `state`, exchange the code (API-4), validate the `id_token`, delete the handshake cookie, set the session cookie, `303 /` |
| **API-42**<a id="api-42"></a> | `GET /bff/session` | `200 {authenticated, user: {displayName}, expiresAt, idleTimeoutSeconds, grantedScopes}` or `401`. Reading it is not activity |
| **API-43**<a id="api-43"></a> | `POST /bff/logout` (a form post; CSRF-checked; optional `reason=idle`) | Destroy the session, clear the cookie, `303` to OpenEMR's end-session endpoint (API-6) with `id_token_hint` and `post_logout_redirect_uri` = `<origin>/signed-out` |
| **API-44**<a id="api-44"></a> | `GET /bff/fhir/{path}` | The allow-listed FHIR read proxy: `{path}` and its query must match one API-10…24 row exactly, judged on the raw request target; anything else is `404` without contacting OpenEMR |
| **API-45**<a id="api-45"></a> | `GET /bff/health` · `GET /bff/ready` | Liveness `200 {"status":"ok","build":"<commit>"}`; readiness `200 {"status":"ready"}` when OpenEMR's SMART discovery (API-2) answers, else `503` with a reason |
| **API-46**<a id="api-46"></a> | `POST /bff/session/activity` (a same-origin `fetch`; CSRF-checked) | The keep-alive: restart the idle clock and answer `200 {expiresAt}`, never past the maximum session length; never calls OpenEMR |
| **API-47**<a id="api-47"></a> | `GET {openemr}/interface/modules/custom_modules/oe-module-agentforge/public/agenda-drilldown-launch.php?patient={uuid}` | Not a call: a new-tab link from the Patient apps slot to the AgentForge module's launch page ([FR-APP-1](REQUIREMENTS.md#fr-app-1)) |

Every token-handler response carries the CSP, HSTS, `Referrer-Policy: same-origin` and `nosniff` headers of
[NFR-SEC-2](REQUIREMENTS.md#nfr-sec-2); `/bff/*` adds `Cache-Control: no-store`. A 4xx the token handler answers
itself is `{"error":"<reason>"}` from a closed set (`malformed_request`, `unauthenticated`, `forbidden`,
`not_found`, `method_not_allowed`, …) and never repeats anything of the request. The full behaviour of each route is
in the [token handler README](openemr-frontend/bff/README.md).

**(B) Token handler → OpenEMR** — §3 to §5. The registered redirect URI is `https://<frontend-origin>/bff/callback`
and the post-logout URI `https://<frontend-origin>/signed-out`, per environment.

### 1.2 The browser's API layer

Only `src/api/` touches the network — an ESLint rule forbids `fetch`, `XMLHttpRequest`, `WebSocket`,
`EventSource` and `sendBeacon` everywhere else, and `src/api/network_boundary.test.ts` proves each variant. Reads go
through TanStack Query; every response is parsed by Zod where it enters the layer, and a Bundle is parsed per entry,
so a bad entry becomes a "Could not display this item" row ([FR-CARD-3](REQUIREMENTS.md#fr-card-3)).

## 2. Scopes

Read-only, least privilege ([FR-AUTH-2](REQUIREMENTS.md#fr-auth-2), [NFR-SEC-4](REQUIREMENTS.md#nfr-sec-4)), in the
SMART v1 `.read` form, because v2 has no `Appointment` or `Medication` scope ([BUG-11](REQUIREMENTS.md#bug-11)).
The machine copy, which the registration script and the token handler read, is
[`openemr-frontend/config/oauth-scopes.json`](openemr-frontend/config/oauth-scopes.json).

| Scope | Why | Tier |
|---|---|---|
| `openid` `fhirUser` | identity; `fhirUser` names the signed-in Practitioner for the app bar | P0 |
| `api:fhir` | the gate for the FHIR API ([BUG-21](REQUIREMENTS.md#bug-21)) | P0 |
| `user/Patient.read` | search and header | P0 |
| `user/AllergyIntolerance.read` · `user/Condition.read` · `user/MedicationRequest.read` · `user/CareTeam.read` · `user/Encounter.read` | the P0 cards | P0 |
| `user/Practitioner.read` · `user/Organization.read` | names on Care Team, Encounter, Prescriptions and Appointments ([BUG-10](REQUIREMENTS.md#bug-10)) | P0 |
| `user/Observation.read` · `user/Immunization.read` · `user/Appointment.read` | the P1 cards | P1 |
| `offline_access` | a refresh token, held by the token handler only, bounded by the 10-hour session ([Q-2](REQUIREMENTS.md#q-2)) | P0 |
| `api:oemr` and REST scopes | **not requested** unless a REST fallback (§6) is activated | — |

The consent screen lets the user untick scopes; a card whose scope was declined shows the not-authorised state.
OpenEMR's ACLs still apply on top of the scopes — the *ACL* column below.

## 3. Authentication calls

| ID | Method · path | Purpose and notes |
|---|---|---|
| **API-1**<a id="api-1"></a> | `GET /oauth2/{site}/.well-known/openid-configuration` | OpenID discovery: the token handler reads only `issuer` and `end_session_endpoint` |
| **API-2**<a id="api-2"></a> | `GET /apis/{site}/fhir/.well-known/smart-configuration` | SMART discovery, authoritative for SMART ([BUG-4](REQUIREMENTS.md#bug-4)): the authorize, token and JWKS endpoints, `S256`, `scopes_supported` (flattened, [BUG-42](REQUIREMENTS.md#bug-42)) and the issuer used as `aud` ([BUG-17](REQUIREMENTS.md#bug-17)) |
| **API-3**<a id="api-3"></a> | `GET /oauth2/{site}/authorize` (browser redirect) | OpenEMR's login and consent: `response_type=code`, `client_id`, `redirect_uri`, `scope`, `state`, `nonce`, `code_challenge`, `code_challenge_method=S256` ([BUG-16](REQUIREMENTS.md#bug-16)), `aud` |
| **API-4**<a id="api-4"></a> | `POST /oauth2/{site}/token` `grant_type=authorization_code` | Exchange the code (1-minute lifetime) with the verifier and `client_secret_post`; returns the access token (1 h), `id_token`, and a refresh token with `offline_access` |
| **API-5**<a id="api-5"></a> | `POST /oauth2/{site}/token` `grant_type=refresh_token` | Renew the access token — the token handler's only; **no `scope`** (omitted means as granted); the refresh token rotates ([BUG-19](REQUIREMENTS.md#bug-19)) |
| **API-6**<a id="api-6"></a> | `GET /oauth2/{site}/logout` | End OpenEMR's session: `id_token_hint` is required and the `post_logout_redirect_uri` must equal a registered one exactly ([BUG-5](REQUIREMENTS.md#bug-5)) |
| **API-7**<a id="api-7"></a> | `GET /oauth2/{site}/jwk` | Public keys to verify the `id_token` (RS256) |
| **API-8**<a id="api-8"></a> | `POST /oauth2/{site}/introspect` | Token validity; not on the clinician's path |
| **API-9**<a id="api-9"></a> | `POST /oauth2/{site}/registration` | One-time setup per environment: register the confidential client ([DEPLOYMENT.md](DEPLOYMENT.md) §4); it is created disabled ([BUG-14](REQUIREMENTS.md#bug-14)) |
| **API-10**<a id="api-10"></a> | `GET /apis/{site}/fhir/metadata` | The CapabilityStatement; on the allow-list for a start-up self-check, not used for readiness ([BUG-28](REQUIREMENTS.md#bug-28)) |

Prerequisites in OpenEMR (configuration, not code): *Administration › Config › Connectors* — enable the Standard
FHIR REST API and set the Site Address (`site_addr_oath`) to OpenEMR's public origin ([DEPLOYMENT.md](DEPLOYMENT.md) §4).

## 4. Data calls — P0

`{id}` is the patient UUID. *ACL* is OpenEMR's per-user check for a `user/` token.

| ID | Method · path | Feeds | Notes | ACL |
|---|---|---|---|---|
| **API-11**<a id="api-11"></a> | `GET /fhir/Patient` with `name`, `birthdate` or `identifier`, `_count`, `_offset` | Patient search ([FR-PAT-1](REQUIREMENTS.md#fr-pat-1)) | `name` is a prefix of one name field ([Q-3](REQUIREMENTS.md#q-3)); `birthdate` a bare `YYYY-MM-DD`; `identifier` the MRN exactly; page order not guaranteed ([BUG-53](REQUIREMENTS.md#bug-53)) | patients/demo |
| **API-12**<a id="api-12"></a> | `GET /fhir/Patient/{id}` | Patient header | name, birth date, gender, MRN (`identifier` of type `PT`), deceased, `active` | patients/demo |
| **API-13**<a id="api-13"></a> | `GET /fhir/AllergyIntolerance?patient={id}` | Allergies | Never filtered on `active`; hide only `resolved` ([BUG-45](REQUIREMENTS.md#bug-45)) | patients/med |
| **API-14**<a id="api-14"></a> | `GET /fhir/Condition?patient={id}&category=problem-list-item` | Problem List | The end date decides "active", not `clinicalStatus` ([BUG-43](REQUIREMENTS.md#bug-43), [BUG-47](REQUIREMENTS.md#bug-47)) | patients/med |
| **API-15**<a id="api-15"></a> | `GET /fhir/MedicationRequest?patient={id}` | Medications | One read, shared with API-16 (logged as `API-15/16`); no `intent` or `status` filter ([BUG-13](REQUIREMENTS.md#bug-13), [BUG-44](REQUIREMENTS.md#bug-44)) | patients/med |
| **API-16**<a id="api-16"></a> | `GET /fhir/MedicationRequest?patient={id}` | Prescriptions | The same read; the card keeps what may be a prescription ([BUG-48](REQUIREMENTS.md#bug-48)) | patients/med |
| **API-17**<a id="api-17"></a> | `GET /fhir/CareTeam?patient={id}` | Care Team | Entered-in-error teams dropped in the app, the active team first ([BUG-52](REQUIREMENTS.md#bug-52)) | patients/med |
| **API-18**<a id="api-18"></a> | `GET /fhir/Practitioner/{id}` (or `?_id=a,b,c`) | Names for care-team members, encounter providers, prescribers, appointment providers and the signed-in user | Each id read once per session and shared; a refusal reads "Name unavailable" ([BUG-10](REQUIREMENTS.md#bug-10)) | admin/users |
| **API-19**<a id="api-19"></a> | `GET /fhir/Organization/{id}` | Facility names | As API-18 | admin/users |
| **API-20**<a id="api-20"></a> | `GET /fhir/Encounter?patient={id}&date=ge{24 months ago}` | Encounter history | Sorted newest first in the app; the window widens on request ([BUG-7](REQUIREMENTS.md#bug-7), [BUG-50](REQUIREMENTS.md#bug-50)); never `Encounter/{id}`, which needs admin/super ([BUG-9](REQUIREMENTS.md#bug-9)) | encounters/auth_a |

## 5. Data calls — P1

| ID | Method · path | Feeds | Notes |
|---|---|---|---|
| **API-21**<a id="api-21"></a> | `GET /fhir/Observation?patient={id}&category=vital-signs&date=ge{12 months ago}` | Vitals | One Observation per vital, sharing the form's time; the newest set is chosen in the app ([BUG-34](REQUIREMENTS.md#bug-34), [BUG-54](REQUIREMENTS.md#bug-54), [BUG-55](REQUIREMENTS.md#bug-55)) |
| **API-22**<a id="api-22"></a> | `GET /fhir/Observation?patient={id}&category=laboratory&date=ge{12 months ago}` | Labs | Never without `date` ([BUG-36](REQUIREMENTS.md#bug-36)); the latest result of each test chosen in the app ([BUG-56](REQUIREMENTS.md#bug-56)…[BUG-58](REQUIREMENTS.md#bug-58)) |
| **API-23**<a id="api-23"></a> | `GET /fhir/Immunization?patient={id}` | Immunizations | Newest first by the administered date as recorded ([BUG-59](REQUIREMENTS.md#bug-59), [BUG-60](REQUIREMENTS.md#bug-60)) |
| **API-24**<a id="api-24"></a> | `GET /fhir/Appointment?patient={id}&date=ge{today}` | Appointments | Every status, soonest first; provider names through API-18 ([BUG-31](REQUIREMENTS.md#bug-31)) |

## 6. REST fallbacks — documented, not called

The standard REST API duplicates most of the P0 data. These rows are kept so a FHIR gap has a known alternative;
activating one means adding `api:oemr` and its scope to §2 and the row to the token handler's allow-list.

| ID | Method · path | Would cover | Id type |
|---|---|---|---|
| **API-30**<a id="api-30"></a> | `GET /api/patient/{puuid}` | header fields FHIR lacks | UUID |
| **API-31**<a id="api-31"></a> | `GET /api/patient/{puuid}/allergy` | allergies (with severity) | UUID |
| **API-32**<a id="api-32"></a> | `GET /api/patient/{puuid}/medical_problem` | problems | UUID |
| **API-33**<a id="api-33"></a> | `GET /api/patient/{pid}/medication` | medication list | numeric pid — avoid |
| **API-34**<a id="api-34"></a> | `GET /api/prescription?patient_id=…` | prescriptions | UUID |
| **API-35**<a id="api-35"></a> | `GET /api/patient/{puuid}/encounter` | encounters (paging broken, [BUG-12](REQUIREMENTS.md#bug-12)) | UUID |
| **API-36**<a id="api-36"></a> | `GET /api/patient/{pid}/appointment` | appointments | numeric pid |

## 7. Traceability — requirement to calls

| Requirement | Calls |
|---|---|
| FR-AUTH-1 sign in | API-40, API-41 → API-1, API-2, API-3, API-4, API-7 |
| FR-AUTH-3 sign out | API-43 → API-6 |
| FR-AUTH-4 automatic logoff | API-42 (the deadline, not activity), API-46 (the keep-alive), API-43 |
| FR-AUTH-5 401 / 403 | API-42, API-44 → API-5 |
| FR-AUTH-6 registration | API-9 |
| FR-BFF-3 read proxy | API-44 → API-10…24 |
| FR-BFF-4 session lifecycle | API-42, API-44 → API-5; API-46; API-43 → API-6 |
| FR-BFF-6 CSRF | API-40, API-43, API-46 |
| FR-BFF-7 health | API-45 → API-2 |
| FR-PAT-1, FR-PAT-2 | API-11, API-12 |
| FR-HDR-1…3 | API-12 |
| FR-UI-3 the signed-in user | API-42 → API-18 (once per session) |
| FR-CARD-ALG-1 · PRB-1 · MED-1 | API-13 · API-14 · API-15 |
| FR-CARD-RX-1 | API-16, API-18 |
| FR-CARD-CT-1 | API-17, API-18, API-19 |
| FR-CARD-ENC-1 | API-20, API-18, API-19 |
| FR-CARD-VIT/LAB/IMM/APT-1 | API-21 … API-24 (APT-1 also API-18) |
| FR-APP-1 | API-47 |

**Requests per dashboard open (P0):** API-12, API-13, API-14, API-15/16 (one read), API-17 and API-20 in parallel,
each an API-44 hop, plus the de-duplicated name reads ([NFR-PERF-3](REQUIREMENTS.md#nfr-perf-3)); each P1 card adds
one read, and one more for each "Show older".
