# Requirements

What the patient-dashboard frontend (`openemr-frontend/`) and its token handler were built to do, and the
OpenEMR behaviours they work around. The IDs here — `UC-`, `FR-`, `NFR-`, `Q-`, `BUG-`, `SCR-` and `W-` — are
the ones the code and tests cite in their comments; each requirement and behaviour has an anchor (`#fr-auth-4`,
`#bug-28`). The server calls (`API-`) are in [INTERFACES.md](INTERFACES.md); how the parts fit together is in
[ARCHITECTURE.md](ARCHITECTURE.md). The AgentForge module's capabilities are summarised in §16.

Priorities: **P0** is the release minimum, **P1** is parity breadth, **P2** is later.

## 1. Summary

OpenEMR's patient dashboard (`interface/patient_file/summary/demographics.php`, SCR-DASH in §15) is a
server-rendered PHP/Twig page inside a jQuery + Knockout + Bootstrap 4 iframe shell. The frontend
**reimplements — does not redesign — that dashboard** as a React + TypeScript single-page app that reads
OpenEMR's existing OAuth2 / OpenID Connect and FHIR R4 APIs, with **no change to the OpenEMR backend**. It
installs as a **PWA** on an Android tablet and is styled with Material Design (MUI) using OpenEMR's own light and
dark theme colours, so it looks like OpenEMR.

## 2. What was asked

Port the patient dashboard to a modern framework over the existing REST and FHIR APIs, without changing the
backend or redesigning the interface: sign-in through OAuth2 / OpenID Connect; a patient header (name, date of
birth, sex, MRN, active status); clinical cards for Allergies, Problem List, Medications, Prescriptions and Care
Team, live from FHIR; one additional section (Encounter history, §6.2); feature parity with the original. The
product owner added: an installable PWA on an Android tablet, Material Design that looks like OpenEMR, user-chosen
light and dark themes, the Google TypeScript Style Guide, and automated testing against a staging environment.

## 3. Goals and non-goals

**Goals.** G1 parity with the legacy dashboard for every in-scope card; G2 standards-only integration (only
OpenEMR's public OAuth2 / FHIR / REST surfaces — configuration, but no code changes); G3 tablet-first and
installable; G4 safe with PHI — nothing kept on the device, the session ends when the clinician walks away (§8);
G5 looks like OpenEMR in light and dark; G6 a documented, defensible framework choice
([ARCHITECTURE.md](ARCHITECTURE.md) §3).

**Non-goals for v1.** Redesign or new clinical features; writing clinical data (v1 is read-only — edits go through
*Open in OpenEMR* links); offline clinical use (offline shows a "no connection" shell with no PHI); porting the rest
of OpenEMR; iOS as a supported target (best effort only); any change to OpenEMR's PHP, schema or API behaviour.

## 4. Users

| Persona | Context | Needs |
|---|---|---|
| **P-1 Clinician** (primary) — outpatient physician, NP or PA | Walks between exam rooms with a clinic-issued Android tablet | Identity at a glance; allergies, problems, medications, prescriptions, care team and recent encounters on one screen; fast; large touch targets; readable in light or dark |
| **P-2 Clinical staff** — nurse, medical assistant | Rooming, medication reconciliation | The same read view; edits stay in OpenEMR |
| **P-3 Practice administrator** | Configures OpenEMR | Registers and enables the API client, sets scopes, manages the tablets (MDM) — one-time setup ([DEPLOYMENT.md](DEPLOYMENT.md) §4, §7) |

A user sees only what their OpenEMR account and granted scopes allow; the frontend adds no authorisation of its own
and never widens it ([NFR-SEC-4](#nfr-sec-4)).

## 5. Use cases

| ID | Use case | Actor | Pri | Requirements |
|---|---|---|---|---|
| **UC-1**<a id="uc-1"></a> | Sign in on the tablet with OpenEMR credentials (OpenEMR's own login and consent) and land on patient search | P-1, P-2 | P0 | FR-AUTH-1…3, FR-AUTH-5, FR-BFF-1, FR-BFF-2, FR-BFF-6, FR-UI-3 |
| **UC-2**<a id="uc-2"></a> | Find and open a patient by name, date of birth or MRN | P-1, P-2 | P0 | FR-PAT-1, FR-PAT-2, FR-UI-5, FR-UI-7 |
| **UC-3**<a id="uc-3"></a> | Review the patient at a glance — header plus Allergies, Problem List, Medications, Prescriptions and Care Team, each loading and failing on its own | P-1, P-2 | P0 | FR-HDR-*, FR-CARD-1…6, FR-CARD-ALG/PRB/MED/RX/CT-1, FR-UI-1, FR-BFF-3 |
| **UC-4**<a id="uc-4"></a> | Review encounter history | P-1 | P0 | FR-CARD-ENC-1 |
| **UC-5**<a id="uc-5"></a> | Install the app to the home screen, launch it standalone, receive updates | P-1, P-3 | P0 | FR-PWA-1…4 |
| **UC-6**<a id="uc-6"></a> | Walk away safely — automatic logoff, explicit sign-out, nothing readable left on the device | P-1, P-2 | P0 | FR-AUTH-3, FR-AUTH-4, FR-BFF-4, FR-BFF-5, FR-UI-4, FR-UI-7, NFR-SEC-1…3 |
| **UC-7**<a id="uc-7"></a> | Choose light, dark or device theme; the choice persists on the device | P-1, P-2 | P0 | FR-UI-2 |
| **UC-8**<a id="uc-8"></a> | Review more context — vitals, labs, immunizations, upcoming appointments | P-1 | P1 | FR-CARD-VIT/LAB/IMM/APT-1 |
| **UC-9**<a id="uc-9"></a> | Jump to OpenEMR to edit a card's data | P-1, P-2 | P1 | FR-CARD-EDIT-1, FR-UI-6 |
| **UC-10**<a id="uc-10"></a> | Launch from OpenEMR with patient context (SMART EHR launch) | P-1 | P2 | FR-PAT-3 |
| **UC-11**<a id="uc-11"></a> | Register and enable the client in OpenEMR | P-3 | P0 | FR-AUTH-6 |
| **UC-12**<a id="uc-12"></a> | Launch a patient app — open a configured per-patient module (AgentForge first) for the open patient in a new tab | P-1 | P1 | FR-APP-1 |

## 6. Scope

### 6.1 Tiers
P0: UC-1…7 and UC-11, the release gate. P1: UC-8, UC-9, UC-12 and the remaining legacy cards with FHIR backing.
P2: UC-10, write parity, phone layout, web push.

### 6.2 Why Encounter history is the additional section
It is what a clinician reads first after the problem list before a follow-up visit; OpenEMR implements the FHIR
`Encounter` resource fully; the demo data seeds encounters; and the legacy dashboard has **no** encounter card
(encounters live in the shell's *Select Encounter* menu and the History tab), so it is the one addition where the
tablet adds real value without a redesign.

### 6.3 Parity — what v1 knowingly does not match
"Feature parity" is an honest claim only with its gaps listed. Each gap comes from what OpenEMR's FHIR API does or
does not send (§14); where the API is ambiguous, a card **errs toward showing** rather than hiding.

| Legacy behaviour | v1 | Because |
|---|---|---|
| Allergy severity label (mild … fatal, "Unassigned") and the highlight on severe and worse | "(high criticality)", "(low criticality)", "(criticality not assessed)" or no label; highlight on `criticality = high` | FHIR carries only a coarse `criticality` ([BUG-41](#bug-41)) |
| Medical Problems hides a resolved problem and lists a problem linked to an encounter | Follows the end date, so may show a resolved problem; a problem linked to an encounter is missing, and the card says so | [BUG-43](#bug-43), [BUG-47](#bug-47) |
| Allergies hide an ended or resolved allergy | Hidden only when OpenEMR sends `resolved` | No end date or Outcome is sent ([BUG-45](#bug-45)) |
| Medications show only the medication list, by begin date, hiding ended entries | Every MedicationRequest of every intent, `plan` first, the others labelled with their intent; one not `active` is marked "may have ended" | `intent` cannot separate list entries from prescriptions, and no end date is sent ([BUG-13](#bug-13), [BUG-44](#bug-44)) |
| Prescriptions show only the prescriptions table, with exact quantity, refills and strength | Also shows list entries that may be prescriptions; refills shown only above 0; quantity never as a bare number; strength and form not shown | [BUG-13](#bug-13), [BUG-48](#bug-48) |
| Empty PAMI cards read "None" / "No Known Allergies" once the list was reviewed | "Nothing Recorded" | The reviewed flag is not exposed ([BUG-46](#bug-46)) |
| Care Team shows member status and note, hides removed members, shows one team | Status and note "Not sent by OpenEMR"; removed members listed; every team not entered in error, the active first | [BUG-52](#bug-52) |
| Immunizations: short CVX name, no date, refused doses not distinguished | Long CVX name (or "CVX {code}", or "Vaccine name not sent by OpenEMR"), administered date, a note on any not marked completed | [BUG-59](#bug-59), [BUG-60](#bug-60) |
| Visit History: every encounter, paged, with billing and form columns | Date, type, reason, provider, facility in a 24-month window that "Show older encounters" widens | FHIR cannot page ([BUG-7](#bug-7)); `type` is a constant ([BUG-50](#bug-50)) |
| Vitals: the most recent form however old, rounded values, BMI status, waist | The most recent set in a 12-month window that widens; both unit systems; values as recorded; no BMI status or waist; a deleted form may show | [BUG-7](#bug-7), [BUG-34](#bug-34), [BUG-54](#bug-54), [BUG-55](#bug-55) |
| Labs: the most recent procedure report with order name, collection date and encounter | The latest result of each test in a 12-month window that widens; name, value, unit, flags, report date | [BUG-36](#bug-36), [BUG-56](#bug-56)…[BUG-58](#bug-58) |
| Appointments: repeating appointments expanded, exact status titles, comments | Each series listed once, on its first day, with a notice; status in words naming what OpenEMR folds together; no comment | [BUG-31](#bug-31) |
| Patient photo in the patient bar | The default silhouette, always ("Photo not shown") | No photo read is available to a non-admin user ([BUG-61](#bug-61)) |
| Add / Edit icons on cards | *Open in OpenEMR* links | v1 is read-only |
| Billing, insurance, messages, reminders, portal and other cards; popups on load; `hide_dashboard_cards` | Not in v1 | Outside the requested card list; several have no API read; globals are not exposed ([Q-4](#q-4)) |
| Module buttons injected through PHP events (AgentForge's "Launch AgentForge") | A configured **Patient apps** slot of new-tab links | The app fires no PHP events ([FR-APP-1](#fr-app-1)) |

## 7. Solution overview

React 19 + TypeScript (strict), Vite, MUI v9, TanStack Query, Zod at the API boundary; sign-in through OpenEMR's
OAuth2 authorization code + PKCE; every token held by a same-origin token handler that also proxies an allow-list of
FHIR reads. The detail is in [ARCHITECTURE.md](ARCHITECTURE.md).

## 8. Why a PWA is acceptable for protected health information

### 8.1 What an installed PWA changes, and what it does not
A PWA is the same web application the clinician could open in Chrome, plus a **manifest** (home-screen install, a
standalone window) and a **service worker** (it can cache files). It gains no new privileges. OpenEMR is already
used in a browser on the same tablets, so the PWA's exposure is that of a browser tab, minus what it refuses to
store. The two ways a PWA could be worse are closed by requirement: the service worker caches the **app shell
only** and never an API response ([FR-PWA-2](#fr-pwa-2)), and nothing clinical is stored on the device at all —
OAuth tokens never reach the tablet ([NFR-SEC-1](#nfr-sec-1)).

### 8.2 HIPAA Security Rule technical safeguards (45 CFR §164.312)

| Safeguard | How it is met | Requirement |
|---|---|---|
| Unique user identification | Every user signs in as their own OpenEMR account | FR-AUTH-1 |
| Automatic logoff | 15-minute inactivity logoff in the app and in the token handler; a 10-hour maximum session | FR-AUTH-4, FR-BFF-4, NFR-SEC-3 |
| Encryption at rest | Nothing clinical stored by the app; device encryption covers the browser profile | NFR-SEC-1, NFR-SEC-7 |
| Audit controls | Every read is an OpenEMR API call under the user's identity, logged by OpenEMR | NFR-SEC-5 |
| Integrity | Read-only; every payload validated before display | NFR-SEC-4, FR-CARD-3 |
| Person or entity authentication | OpenEMR's login (and MFA where enabled) behind authorization code + PKCE | FR-AUTH-1 |
| Transmission security | HTTPS only, HSTS, a strict CSP | NFR-SEC-2 |

Physical and administrative safeguards — device management, training, business associate agreements — are the
practice's, stated as deployment prerequisites ([NFR-SEC-7](#nfr-sec-7), [DEPLOYMENT.md](DEPLOYMENT.md) §7).

### 8.3 Alternatives considered
A plain responsive website (the same posture, but no install); a native Android app (the strongest platform
controls, but a second codebase — rejected); a Capacitor shell around the same SPA (can block screenshots — kept as
the escalation path, §8.5); the installable PWA — **chosen**.

### 8.4 Residual risks, accepted with mitigation

| Risk | Mitigation | Residual |
|---|---|---|
| The Android recents thumbnail or a screenshot captures PHI; a PWA cannot block screenshots | The privacy cover goes up when the app is hidden ([FR-UI-4](#fr-ui-4)); device policy can disable capture on managed tablets | Low, with MDM |
| A lost or stolen tablet while signed in | Automatic logoff; no tokens on the device; screen lock and remote wipe by MDM | Low |
| A shared tablet shows the previous patient | Sign-out and logoff clear every cache and return to sign-in | Low |
| A stale app shell after a security fix | The prompt-to-update flow ([FR-PWA-3](#fr-pwa-3)) | Low |
| Token theft through XSS | Tokens stay in the token handler; a strict CSP; React escaping; dependency scanning | Low — an XSS could still act as the session while it lives, as with OpenEMR's own session cookie |
| Unmanaged browsers or extensions | Device management restricts what runs on clinic tablets | Practice-dependent |

### 8.5 The escalation path: Capacitor
If a practice's security review demands **app-level** screenshot blocking that device policy cannot give, the same
SPA can be wrapped in a Capacitor Android shell, which can set `FLAG_SECURE`. It carries a real cost — a native
toolchain, signing keys, managed-Play distribution, sign-in moved to the system browser, and a redesign of the
same-origin cookie model — so it was not taken for v1.

## 9. Look and feel
Material 3 components (MUI) with OpenEMR's palette: light colours from OpenEMR's `style_light` theme, dark from
`style_dark`, adjusted only where needed to reach WCAG AA contrast. A theme selector offers Light, Dark and Match
device. Landscape mirrors the legacy layout (a row of Allergies · Problems · Medications, then full-width cards, then
two columns); portrait stacks to one column; touch targets are at least 48 dp.

## 10. Success measures

| Measure | Target |
|---|---|
| P0 parity on the demo patients | Every P0 card shows the same items as legacy, the gaps in §6.3 aside |
| Time to dashboard on the reference tablet | ≤ 2.0 s p75 ([NFR-PERF-1](#nfr-perf-1); at risk, [Q-8](#q-8)) |
| Installability | Passes Chrome's installability checks |
| PHI at rest after sign-out or timeout | None in any web storage or Cache Storage |
| Backend changes made for the frontend | None |

## 11. Decisions and open questions

| ID | Question | State |
|---|---|---|
| **Q-1**<a id="q-1"></a> | Serve the SPA from OpenEMR's origin or its own? | **Decided by Q-7:** the token handler serves the SPA and `/bff/*` from one origin, so OpenEMR's CORS behaviour does not matter. The public hostname per environment is a deployment choice |
| **Q-2**<a id="q-2"></a> | How long may one session last, independent of the inactivity logoff? | **Decided: one clinic day, 10 hours** from sign-in, enforced by the token handler (`BFF_MAX_SESSION_SECONDS`); server-side refresh needs `offline_access` |
| **Q-3**<a id="q-3"></a> | Are FHIR `name`, `birthdate` and `identifier` enough for patient search? | **Yes, with limits:** `name` matches one name field by prefix, so a first and last name together match nothing — the search screen says to search one name at a time; `identifier` matches the MRN exactly |
| **Q-4**<a id="q-4"></a> | Honour `hide_dashboard_cards` and the other dashboard globals? | Open — no API exposes them (P2) |
| **Q-5**<a id="q-5"></a> | Which reference tablet sets the performance and layout targets? | Assumed 10–11″, 1280×800 CSS px |
| **Q-6**<a id="q-6"></a> | Are Prescriptions distinct from Medications in FHIR? | **No, not by `intent`.** Both cards read every MedicationRequest; each keeps its own rows and labels the ambiguous ones ([BUG-13](#bug-13)) |
| **Q-7**<a id="q-7"></a> | Client type and token custody | **Decided: a token handler (option A).** OpenEMR refuses `user/` scopes to public clients ([BUG-1](#bug-1)), a patient-scoped public client cannot serve a clinician, and changing OpenEMR would break [NFR-CON-1](#nfr-con-1). The token handler is a confidential client on the SPA's own origin, keeps every token server-side and proxies an allow-list of FHIR reads |
| **Q-8**<a id="q-8"></a> | Risk: FHIR latency against the 2-second target | Open — FHIR searches take seconds under fan-out ([BUG-28](#bug-28)); measure on the reference tablet |
| **Q-9**<a id="q-9"></a> | Care Team and encounter names need the `admin/users` ACL ([BUG-10](#bug-10)) | Open — the cards show "Name unavailable" when refused; granting the ACL is OpenEMR configuration |
| **Q-10**<a id="q-10"></a> | Care Team is empty in the demo data ([BUG-30](#bug-30)) | **Decided:** the AgentForge module's seeders create a demo care team for each demo patient |
| **Q-11**<a id="q-11"></a> | Who holds the production business associate agreement with the host, and is OpenEMR's host covered? | Open — decide before any production deployment |
| **Q-12**<a id="q-12"></a> | Must screen capture be disabled on every production tablet? | Open — the practice's risk analysis |
| **Q-13**<a id="q-13"></a> | How is the PWA provisioned on managed tablets? | Open — choose and verify the EMM |
| **Q-14**<a id="q-14"></a> | Where is sign-in rate-limited in production? | Open — at the edge in front of the token handler ([DEPLOYMENT.md](DEPLOYMENT.md) §7) |

## 12. Functional requirements

### AUTH — Authentication and session

| ID | Requirement | Pri |
|---|---|---|
| **FR-AUTH-1**<a id="fr-auth-1"></a> | Sign in through OpenEMR's OAuth2 / OpenID Connect authorization-code flow with PKCE (S256), on OpenEMR's own login and consent screens. `state`, `nonce` and the `id_token` (issuer, audience, expiry, signature via JWKS) are validated. No client secret reaches the browser: the client is confidential and held by the token handler ([Q-7](#q-7)). | P0 |
| **FR-AUTH-2**<a id="fr-auth-2"></a> | Request only the read scopes the features need: `openid`, `fhirUser`, `api:fhir`, the `user/<Resource>.read` scopes, and `offline_access` for server-side refresh ([INTERFACES.md](INTERFACES.md) §2). | P0 |
| **FR-AUTH-3**<a id="fr-auth-3"></a> | Sign out: the token handler destroys the session and its tokens and ends the OpenEMR session; the browser clears every cache and all rendered PHI and shows the signed-out page. | P0 |
| **FR-AUTH-4**<a id="fr-auth-4"></a> | Automatic logoff after inactivity (default 15 minutes) with a one-minute on-screen warning. Touch, key and scroll count as activity; recent input sends one automatic keep-alive instead of the warning, at most one per input, so an unattended tablet still times out. The warning's "Stay signed in" is the keep-alive; at zero the app clears its data and signs out with `reason=idle`. The token handler enforces the same period server-side ([FR-BFF-4](#fr-bff-4)). Sign-out never waits on the network. | P0 |
| **FR-AUTH-5**<a id="fr-auth-5"></a> | Token refresh is invisible to the app. A **401** from `/bff/*` means the session is over: clear PHI and show sign-in. A **403** shows a per-card "Not authorised to view" state — never a retry loop. | P0 |
| **FR-AUTH-6**<a id="fr-auth-6"></a> | A documented, repeatable client registration per environment: redirect and post-logout URIs, scopes, client type, and enabling the client in OpenEMR ([DEPLOYMENT.md](DEPLOYMENT.md) §4). | P0 |

### BFF — token handler

| ID | Requirement | Pri |
|---|---|---|
| **FR-BFF-1**<a id="fr-bff-1"></a> | **One origin:** the token handler serves the built SPA and its `/bff/*` routes over HTTPS. The browser's only credential is an opaque session cookie (`__Host-` prefix, `HttpOnly; Secure; SameSite=Strict; Path=/`). Because OpenEMR's redirect back is a cross-site navigation, the sign-in state is keyed by a separate short-lived handshake cookie (`SameSite=Lax`, at most 10 minutes), set at login and deleted at the callback. | P0 |
| **FR-BFF-2**<a id="fr-bff-2"></a> | **Confidential client, tokens server-side:** runs authorization code + PKCE with the client secret, holds the access, refresh and id tokens only in server memory keyed by the session id, and validates `state`, `nonce` and the `id_token`. The secret comes from the environment only. | P0 |
| **FR-BFF-3**<a id="fr-bff-3"></a> | **Allow-listed read proxy:** `/bff/fhir/*` forwards only the `GET` reads listed in [INTERFACES.md](INTERFACES.md) (API-10…24) with the bearer token attached; anything else is a 404 without contacting OpenEMR. Client cookies and `Authorization` are stripped; OpenEMR's status and body pass through. | P0 |
| **FR-BFF-4**<a id="fr-bff-4"></a> | **Session lifecycle:** refresh the access token server-side a minute before expiry, one refresh per session at a time, storing the rotated refresh token ([BUG-19](#bug-19)); a failed refresh ends the session. End the session `BFF_IDLE_TIMEOUT_SECONDS` (default 900) after the last authenticated request or keep-alive, and `BFF_MAX_SESSION_SECONDS` (default 36 000) after sign-in. Sign-out destroys the session, ends OpenEMR's with `id_token_hint`, and clears the cookie. | P0 |
| **FR-BFF-5**<a id="fr-bff-5"></a> | **No PHI kept or logged:** proxied answers are held in memory for one request only, never cached or written to disk (`Cache-Control: no-store`); logs carry the method, `API-` id, status and latency — never bodies, identifying query strings or tokens. | P0 |
| **FR-BFF-6**<a id="fr-bff-6"></a> | **CSRF and header hardening:** state-changing routes (sign-in, sign-out, keep-alive) accept only `POST`; `Sec-Fetch-Site` must be `same-origin` when present, otherwise `Origin` must equal the app's origin; neither present is refused. Every response carries the headers of [NFR-SEC-2](#nfr-sec-2). | P0 |
| **FR-BFF-7**<a id="fr-bff-7"></a> | **Health:** `/bff/health` (liveness, never calls OpenEMR) and `/bff/ready` (OpenEMR's SMART discovery reachable; one answer reused for 5 seconds, so probes reach OpenEMR at most once per window), with no PHI and no authentication. | P1 |

### PAT — Patient selection

| ID | Requirement | Pri |
|---|---|---|
| **FR-PAT-1**<a id="fr-pat-1"></a> | Search patients by name (partial, at least 2 characters), date of birth and MRN; results list name, date of birth, sex and MRN, paged; a tap opens the dashboard. | P0 |
| **FR-PAT-2**<a id="fr-pat-2"></a> | Open a dashboard by the patient's logical id; Back returns to the results. No name, date of birth or MRN ever appears in a URL. | P0 |
| **FR-PAT-3**<a id="fr-pat-3"></a> | SMART EHR launch from OpenEMR with patient context, opening that patient's dashboard. | P2 |

### HDR — Patient header

| ID | Requirement | Pri |
|---|---|---|
| **FR-HDR-1**<a id="fr-hdr-1"></a> | A persistent identity bar — name, date of birth with age, sex, MRN, active status — that stays visible while the cards scroll. | P0 |
| **FR-HDR-2**<a id="fr-hdr-2"></a> | A deceased patient shows a prominent danger-coloured indication with the date and age at death. | P0 |
| **FR-HDR-3**<a id="fr-hdr-3"></a> | Inactive status is distinct by more than colour; a missing field reads "—" with an accessible label, never blank. | P0 |
| **FR-HDR-4**<a id="fr-hdr-4"></a> | Patient photo with a silhouette fallback. **Deferred:** no photo read is available to a non-admin user ([BUG-61](#bug-61)), so the header always shows the silhouette, named "Photo not shown", and reads nothing for it. | P2 |

### CARD — Clinical cards

| ID | Requirement | Pri |
|---|---|---|
| **FR-CARD-1**<a id="fr-card-1"></a> | Each card has a title, a collapse control and its own loading, empty, error and not-authorised states; cards load in parallel; one card's failure never blocks another, and the next patient's chart tries that card again. | P0 |
| **FR-CARD-2**<a id="fr-card-2"></a> | Card collapse state persists per device (a preference, not PHI). | P1 |
| **FR-CARD-3**<a id="fr-card-3"></a> | Every payload is validated at the boundary; a malformed item renders "Could not display this item" rather than vanishing or breaking the card. | P0 |
| **FR-CARD-4**<a id="fr-card-4"></a> | Empty states use the legacy wording ("Nothing Recorded"), except that a card never claims a review the API cannot show ([BUG-46](#bug-46)). | P0 |
| **FR-CARD-5**<a id="fr-card-5"></a> | A dashboard-level refresh re-fetches every card; each card shows when its data was fetched; no background polling. | P1 |
| **FR-CARD-6**<a id="fr-card-6"></a> | Tapping a row opens a read-only item-detail dialog showing only the fields the card's own read returned; focus moves in, is trapped, and returns on close; Escape closes. | P1 |
| **FR-CARD-EDIT-1**<a id="fr-card-edit-1"></a> | Cards whose legacy counterpart has Add or Edit show **Open in OpenEMR**, linking to that legacy screen for the patient. | P1 |
| **FR-CARD-ALG-1**<a id="fr-card-alg-1"></a> | **Allergies:** every allergy except `resolved` (never filtered on `active`, [BUG-45](#bug-45)) — substance, criticality, reaction; `high` criticality highlighted; all four criticality cases handled, an absent one never shown as low ([BUG-41](#bug-41)). | P0 |
| **FR-CARD-PRB-1**<a id="fr-card-prb-1"></a> | **Problem List:** active problems — title and onset, oldest onset first, undated first. "Active" is the legacy end-date rule, never `clinicalStatus` ([BUG-43](#bug-43)); an unreadable end date errs toward showing; the card warns that problems linked to an encounter may be missing ([BUG-47](#bug-47)). | P0 |
| **FR-CARD-MED-1**<a id="fr-card-med-1"></a> | **Medications:** name and dosage instructions; every intent shown, `plan` first and unlabelled, the rest labelled ([BUG-13](#bug-13)); an entry not `active` is marked "may have ended" ([BUG-44](#bug-44)). | P0 |
| **FR-CARD-RX-1**<a id="fr-card-rx-1"></a> | **Prescriptions:** drug, dose / sig, quantity, refills, prescriber, date and status, newest first, excluding `stopped`; keeps every entry that may be a prescription. Refills are never shown as 0, a quantity never as a bare number, and the strength not at all ([BUG-48](#bug-48)). | P0 |
| **FR-CARD-CT-1**<a id="fr-card-ct-1"></a> | **Care Team:** members with type, name, role, facility, since, status and note, under each team (teams entered in error hidden, the active team first). A name OpenEMR will not give reads "Name unavailable" ([BUG-10](#bug-10)), each name read once per session; missing status and note say so ([BUG-52](#bug-52)). | P0 |
| **FR-CARD-ENC-1**<a id="fr-card-enc-1"></a> | **Encounter history:** newest first — date, class, reason, provider, facility — in a 24-month window that "Show older encounters" widens ([BUG-7](#bug-7), [BUG-50](#bug-50)); a partial search ends in "More encounters not shown". | P0 |
| **FR-CARD-VIT-1**<a id="fr-card-vit-1"></a> | **Vitals:** the most recent set with its recorded date and time, each vital as legacy labels it, in both unit systems; placeholders, means and entered-in-error readings dropped ([BUG-34](#bug-34)); never two forms mixed; a 12-month window that widens ([BUG-7](#bug-7), [BUG-35](#bug-35), [BUG-51](#bug-51), [BUG-54](#bug-54), [BUG-55](#bug-55)). | P1 |
| **FR-CARD-LAB-1**<a id="fr-card-lab-1"></a> | **Labs:** the latest result of each test, newest first — name, value, unit, abnormal flag and non-final status in words, the report date as recorded; a 12-month window that widens ([BUG-36](#bug-36), [BUG-51](#bug-51), [BUG-56](#bug-56)…[BUG-58](#bug-58)). | P1 |
| **FR-CARD-IMM-1**<a id="fr-card-imm-1"></a> | **Immunizations:** every immunization but one entered in error, newest first, with its vaccine name and administered date; one not marked completed is listed with a note ([BUG-51](#bug-51), [BUG-59](#bug-59), [BUG-60](#bug-60)). | P1 |
| **FR-CARD-APT-1**<a id="fr-card-apt-1"></a> | **Appointments:** every appointment from today on, whatever its status, soonest first — date and time, category, provider, status; the first 10 and the rest of the tenth's day, then "More appointments from {day}"; a notice that repeating appointments may be missing ([BUG-31](#bug-31), [BUG-10](#bug-10), [BUG-51](#bug-51)). | P1 |

### UI — Layout, theme, navigation

| ID | Requirement | Pri |
|---|---|---|
| **FR-UI-1**<a id="fr-ui-1"></a> | Adaptive layout on Material window-size classes: landscape (≥ 840 dp) in the legacy arrangement; portrait (600–839 dp) one column in legacy order; compact usable. | P0 |
| **FR-UI-2**<a id="fr-ui-2"></a> | Theme selector — Light, Dark, Match device (the default) — persisted per device; switching never reloads data. | P0 |
| **FR-UI-3**<a id="fr-ui-3"></a> | App bar: the OpenEMR logo, the signed-in user with sign-out, the theme selector, patient search, and the app version (the package version plus the short commit when the build names one). | P0 |
| **FR-UI-4**<a id="fr-ui-4"></a> | Privacy screen: when the app is hidden, an opaque cover goes up at once over everything, so the recents thumbnail shows no patient data. Back within the grace period (`VITE_PRIVACY_GRACE_SECONDS`, 0–900, default 60) the chart is as it was; hidden longer, the app signs out as [FR-AUTH-4](#fr-auth-4) does. | P0 |
| **FR-UI-5**<a id="fr-ui-5"></a> | Navigation: a rail in landscape, a drawer in portrait — Patients, Dashboard (disabled until a patient is open, still focusable, with a reason), Settings; the drawer may list this session's patients, held in memory only. | P0 |
| **FR-UI-6**<a id="fr-ui-6"></a> | Patient sections: a tab list holding the Dashboard tab, then a separate "Open in OpenEMR" group of links to the patient's legacy screens. | P1 |
| **FR-UI-7**<a id="fr-ui-7"></a> | Switching to another patient's chart and signing out each ask for confirmation in a modal whose safe action has initial focus; Escape cancels and focus returns to the opener. Browser Back / Forward onto another chart is not confirmed, because the chart shown is always the one the URL names. | P1 |

### PWA — Installable app

| ID | Requirement | Pri |
|---|---|---|
| **FR-PWA-1**<a id="fr-pwa-1"></a> | Installable on Android Chrome: a web-app manifest (name, icons including maskable 192 and 512, standalone display, start URL, scope, theme colours), served over HTTPS. | P0 |
| **FR-PWA-2**<a id="fr-pwa-2"></a> | The service worker precaches the app shell only (`index.html` and the fingerprinted `assets/`) and has no runtime caching; `/bff/**` is network-only. A test asserts that after sign-in, use and sign-out, Cache Storage holds exactly the precache entries. | P0 |
| **FR-PWA-3**<a id="fr-pwa-3"></a> | A new version is announced ("Update available — reload") and never swapped in mid-session. | P0 |
| **FR-PWA-4**<a id="fr-pwa-4"></a> | Offline, the shell opens and says patient data is not available offline; no PHI; it resumes when online. | P0 |

### APP — Patient apps

| ID | Requirement | Pri |
|---|---|---|
| **FR-APP-1**<a id="fr-app-1"></a> | A **Patient apps** slot under the patient header, configured at build time by `VITE_PATIENT_APPS` — a JSON list of `{label, url, aclHint?}` whose absolute https `url` holds `{patientId}`, replaced by the open patient's FHIR id. Unset or invalid means no slot. Each app is a link opening in a new top-level tab — never an iframe ([BUG-25](#bug-25)) — described by "OpenEMR may ask you to sign in first." ([BUG-24](#bug-24)). AgentForge is launched through its module's `agenda-drilldown-launch.php?patient={patientId}` (API-47). | P1 |

## 13. Non-functional requirements

### SEC — Security and privacy

| ID | Requirement | Pri |
|---|---|---|
| **NFR-SEC-1**<a id="nfr-sec-1"></a> | **No PHI at rest on the device.** Nothing clinical in `localStorage`, IndexedDB, Cache Storage or app-controlled cookies; OAuth tokens never reach the browser, with one bounded exception — the `id_token`, sent once as `id_token_hint` in the sign-out redirect after the session is destroyed ([BUG-5](#bug-5)). Allowed in `localStorage`: the theme choice and card collapse state, nothing else. | P0 |
| **NFR-SEC-2**<a id="nfr-sec-2"></a> | **Transport and content security:** HTTPS, HSTS, a strict CSP (`default-src 'self'`, `connect-src 'self'`, `form-action 'self'` plus OpenEMR's authorize origin, no inline scripts), `Referrer-Policy: same-origin`, `X-Content-Type-Options: nosniff`. `style-src 'unsafe-inline'` stays by decision, because MUI injects styles at runtime; a per-request nonce is not safe with the precached offline shell, and a test pins the directive set. | P0 |
| **NFR-SEC-3**<a id="nfr-sec-3"></a> | **Session lifetime bounded:** automatic logoff, a 10-hour maximum, nothing surviving app close except the two preferences. | P0 |
| **NFR-SEC-4**<a id="nfr-sec-4"></a> | **Least privilege, read-only:** read scopes only; no authorisation of the app's own — what the user sees is what OpenEMR's ACLs and scopes return. | P0 |
| **NFR-SEC-5**<a id="nfr-sec-5"></a> | **Auditable reads:** every clinical read is an OpenEMR API call under the user's token; no alternate data path, no client cache serving reads. | P0 |
| **NFR-SEC-6**<a id="nfr-sec-6"></a> | **No PHI in logs or telemetry:** none in the console, error reports, URLs or page titles. | P0 |
| **NFR-SEC-7**<a id="nfr-sec-7"></a> | **Deployment prerequisites** (not software): managed Android tablets with screen lock, encryption, remote wipe and, where required, screen capture disabled; a TLS certificate on the served origin; a business associate agreement with each host ([DEPLOYMENT.md](DEPLOYMENT.md) §7). | P0 |
| **NFR-SEC-8**<a id="nfr-sec-8"></a> | **Dependency hygiene:** lockfiles committed; `npm audit` (high and critical) against an allow-list of dated, reasoned exceptions (`config/audit-allowlist.json`); every production dependency's licence checked against `config/licence-allowlist.json`; no script or stylesheet from another origin. | P1 |

### PERF — Performance

| ID | Requirement | Pri |
|---|---|---|
| **NFR-PERF-1**<a id="nfr-perf-1"></a> | Patient selected to all P0 cards rendered in ≤ 2.0 s p75 on the reference tablet ([Q-8](#q-8)). | P0 |
| **NFR-PERF-2**<a id="nfr-perf-2"></a> | Initial JavaScript ≤ 250 kB gzipped; LCP ≤ 2.5 s on the reference tablet. | P1 |
| **NFR-PERF-3**<a id="nfr-perf-3"></a> | No N+1 fetching: each card is a bounded number of requests; practitioner and organization names are read once per session and shared. | P1 |

### A11Y, COMPAT and UX

| ID | Requirement | Pri |
|---|---|---|
| **NFR-A11Y-1**<a id="nfr-a11y-1"></a> | WCAG 2.2 AA in both themes: contrast, visible focus, labels, landmarks, status not by colour alone. | P0 |
| **NFR-A11Y-2**<a id="nfr-a11y-2"></a> | Touch targets ≥ 48 × 48 dp, no hover-only affordances, portrait and landscape, font scaling to 130 %. | P0 |
| **NFR-COMPAT-1**<a id="nfr-compat-1"></a> | Primary: Chrome for Android (current and previous) on 10–11″ tablets. Secondary: current desktop Chrome, Edge and Firefox. Best effort: iOS Safari. | P0 |
| **NFR-UX-1**<a id="nfr-ux-1"></a> | Reimplement, don't redesign: the same facts, grouping, order, emphasis and empty states as the legacy dashboard, deviating only as §6.3 lists. | P0 |
| **NFR-UX-2**<a id="nfr-ux-2"></a> | Looks like OpenEMR: palette, type and card shape from OpenEMR's theme. | P0 |

### CON, CODE, TEST and DOC

| ID | Requirement | Pri |
|---|---|---|
| **NFR-CON-1**<a id="nfr-con-1"></a> | No backend changes for the frontend: no PHP, SQL, schema or API-behaviour change in OpenEMR. Configuration is allowed. | P0 |
| **NFR-CON-2**<a id="nfr-con-2"></a> | Data only through OpenEMR's public OAuth2 / FHIR R4 / standard REST surfaces listed in [INTERFACES.md](INTERFACES.md); no scraping of PHP pages or internal AJAX endpoints. | P0 |
| **NFR-CODE-1**<a id="nfr-code-1"></a> | The Google TypeScript Style Guide, enforced by `gts` with typescript-eslint strict-type-checked ([CONVENTIONS.md](CONVENTIONS.md)). | P0 |
| **NFR-CODE-2**<a id="nfr-code-2"></a> | TypeScript `strict` plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`; no `any`; types from FHIR R4 plus Zod schemas. | P0 |
| **NFR-TEST-1**<a id="nfr-test-1"></a> | Test-first unit and component tests (Vitest, React Testing Library, MSW) for every public behaviour. | P0 |
| **NFR-TEST-2**<a id="nfr-test-2"></a> | Automated end-to-end tests (Playwright) against a staging environment with real OAuth and FHIR, synthetic data only. | P0 |
| **NFR-TEST-3**<a id="nfr-test-3"></a> | Every OpenEMR behaviour in §14 that affects the app has a test pinning the workaround. | P1 |
| **NFR-DOC-1**<a id="nfr-doc-1"></a> | The framework choice is documented and defended ([ARCHITECTURE.md](ARCHITECTURE.md) §3). | P0 |
| **NFR-DOC-2**<a id="nfr-doc-2"></a> | A change to behaviour, an API call or configuration updates these documents in the same change. | P0 |

## 14. Known OpenEMR behaviours

OpenEMR quirks and defects as they affect the frontend; the code cites them by ID where it works around them.
"Fixed in the fork" marks the three this repository corrects in OpenEMR itself ([ARCHITECTURE.md](ARCHITECTURE.md) §4).

### A. OAuth2 and SMART

| ID | Behaviour | Effect, and what the code does |
|---|---|---|
| **BUG-1**<a id="bug-1"></a> | Public clients cannot hold `user/` scopes | A browser-only client cannot serve a clinician — designed around with the token handler ([Q-7](#q-7)) |
| **BUG-2**<a id="bug-2"></a> | The CORS preflight is malformed and reflects any origin | No effect: the browser makes no cross-origin call |
| **BUG-3**<a id="bug-3"></a> | Discovery advertises a `/userinfo` endpoint that 404s | Not used |
| **BUG-4**<a id="bug-4"></a> | The OpenID and SMART discovery documents disagree | SMART discovery is authoritative for SMART |
| **BUG-5**<a id="bug-5"></a> | Logout requires `id_token_hint`, a matching nonce and an exact registered post-logout URI | The token handler keeps the sign-in `id_token` for sign-out and registers `<origin>/signed-out` exactly |
| **BUG-11**<a id="bug-11"></a> | Gaps in the scope catalogue; one unknown scope fails the whole sign-in | SMART v1 `.read` scopes only; sign-in is refused, naming the missing scopes, if discovery lacks one |
| **BUG-14**<a id="bug-14"></a> | New confidential clients with `user/` scopes are created disabled | An administrator enables the client after registration ([DEPLOYMENT.md](DEPLOYMENT.md) §4) |
| **BUG-15**<a id="bug-15"></a> | `token_endpoint_auth_method: none` is rejected | No effect (a confidential client) |
| **BUG-16**<a id="bug-16"></a> | PKCE must be S256 and the method must be sent | Always sent |
| **BUG-17**<a id="bug-17"></a> | `aud` must equal the FHIR base built from the `site_addr_oath` global | `aud` is taken from SMART discovery's issuer |
| **BUG-18**<a id="bug-18"></a> | Token introspection quirks | Not on the clinician's path |
| **BUG-19**<a id="bug-19"></a> | One-hour access tokens; rotating refresh tokens only with `offline_access` | One refresh per session at a time; the rotated token is stored; a refresh sends no `scope` |
| **BUG-20**<a id="bug-20"></a> | Unregistered scopes are dropped silently | A declined or dropped scope surfaces as a per-card not-authorised state |
| **BUG-21**<a id="bug-21"></a> | FHIR scopes require `api:fhir` | Requested |
| **BUG-22**<a id="bug-22"></a> | All of `/oauth2` 404s when the API globals are off | A setup step ([DEPLOYMENT.md](DEPLOYMENT.md) §4) |
| **BUG-23**<a id="bug-23"></a> | An EHR launch lands on `main.php` without two skip flags | Matters only for EHR launch (P2) |
| **BUG-24**<a id="bug-24"></a> | EHR-launch single sign-on asks for a second login | Patient-app links warn that OpenEMR may ask to sign in |
| **BUG-25**<a id="bug-25"></a> | OpenEMR's `SameSite=Strict` session cookie breaks OAuth inside a frame or WebView | Patient apps open in a new tab, never an iframe |
| **BUG-26**<a id="bug-26"></a> | The Register-App admin screen fails with an empty JWKS box | Register with the script instead ([DEPLOYMENT.md](DEPLOYMENT.md) §4) |
| **BUG-27**<a id="bug-27"></a> | Stale and duplicate OAuth clients accumulate | One client per environment, its id recorded in `config/oauth-clients.json` |
| **BUG-42**<a id="bug-42"></a> | SMART's `scopes_supported` is nested one array deep | Flattened before use |

### B. FHIR data and search

| ID | Behaviour | Effect, and what the code does |
|---|---|---|
| **BUG-6**<a id="bug-6"></a> | `Patient.active` was always `true` | **Fixed in the fork:** `active` now mirrors `deceased[x]` |
| **BUG-7**<a id="bug-7"></a> | FHIR paging does not work (partly on Patient); `total` counts only the entries returned | Clinical reads are date-windowed and widened on request |
| **BUG-8**<a id="bug-8"></a> | Few search parameters; no clinical-status filter; no `_include` | Filtering is done in the app |
| **BUG-9**<a id="bug-9"></a> | With a `user/` token several resources need `admin/super` | Those reads are avoided |
| **BUG-10**<a id="bug-10"></a> | Practitioner and Organization reads need `admin/users` | Names read once per session; a refusal reads "Name unavailable" |
| **BUG-12**<a id="bug-12"></a> | REST `links.next` uses `_count` while the server reads `_limit` | No effect (REST is not called) |
| **BUG-13**<a id="bug-13"></a> | MedicationRequest merges prescriptions and the medication list, and `intent` cannot tell them apart | Both cards read every intent, share one read, and label the ambiguous rows |
| **BUG-29**<a id="bug-29"></a> | Patient UUIDs versus the numeric `pid` | FHIR uses the UUID throughout |
| **BUG-30**<a id="bug-30"></a> | CareTeam is empty in the demo data | The module's seeders create demo care teams |
| **BUG-31**<a id="bug-31"></a> | Appointment: few search parameters, a lossy status, a repeating series sent once at its first date, a provider without an NPI sent as `Person/` | Status shown as the folded set in words; a notice about repeating appointments; "Name unavailable" |
| **BUG-32**<a id="bug-32"></a> | Seeded appointments with a NULL end date are hidden in the calendar but present in FHIR | Low |
| **BUG-33**<a id="bug-33"></a> | Error bodies are not always `OperationOutcome` (some carry the REST envelope) | Both shapes parsed and passed through |
| **BUG-34**<a id="bug-34"></a> | Vitals: null placeholder observations; blood-pressure means dropped | Placeholders and means dropped before the newest set is chosen |
| **BUG-35**<a id="bug-35"></a> | Time zones: Observation keeps its offset, appointment dates are local | Dates read as written; the tablet must use the clinic's time zone |
| **BUG-36**<a id="bug-36"></a> | A lab search without `date` returns the whole history | Lab reads always carry a `date` window |
| **BUG-53**<a id="bug-53"></a> | Patient search pages have no guaranteed order | A row could repeat or be skipped across pages (low) |
| **BUG-54**<a id="bug-54"></a> | Vitals still returns a deleted vitals form | It can be the set shown |
| **BUG-55**<a id="bug-55"></a> | Vitals omits waist circumference and BMI status and sends the oximetry twice | Two rows missing; the duplicate dropped |
| **BUG-56**<a id="bug-56"></a> | Lab results drop the name without a LOINC code, a text result's unit, and a result of 0 | Each case says so on the row |
| **BUG-57**<a id="bug-57"></a> | Every lab result status but final arrives as `unknown` | Reads "Status unknown" |
| **BUG-58**<a id="bug-58"></a> | Lab results are one row per result, dated by the report, without order name, collection date or encounter | The legacy procedure line cannot be shown |

### C. Performance and operations

| ID | Behaviour | Effect, and what the code does |
|---|---|---|
| **BUG-28**<a id="bug-28"></a> | FHIR is slow: `metadata` about 4.7 s, searches 4–8.5 s under fan-out | Readiness uses SMART discovery, not `metadata`; the token handler caps concurrent upstream reads and queues the rest |
| **BUG-37**<a id="bug-37"></a> | Configuration drifts between environments | Configuration recorded per environment ([DEPLOYMENT.md](DEPLOYMENT.md)) |
| **BUG-38**<a id="bug-38"></a> | "0 % errors" can hide failing reads | The proxy counts 401, 403 and empty results separately |

### D. Legacy screens and clinical data the app's users see

| ID | Behaviour | Effect, and what the code does |
|---|---|---|
| **BUG-39**<a id="bug-39"></a> | The OAuth login page blocked pinch-zoom | **Fixed in the fork** |
| **BUG-40**<a id="bug-40"></a> | The OAuth login fields had no labels | **Fixed in the fork** |
| **BUG-41**<a id="bug-41"></a> | AllergyIntolerance omits onset, recorded date and reaction severity; criticality is coarse | The card shows criticality in words; the detail dialog omits what is not sent |
| **BUG-43**<a id="bug-43"></a> | Condition `clinicalStatus` disagrees with the legacy card: an open first occurrence is `resolved` | The Problem List follows the end date |
| **BUG-44**<a id="bug-44"></a> | MedicationRequest sends no end date; `completed` covers an end date still to come | Never filtered on status; marked "may have ended" |
| **BUG-45**<a id="bug-45"></a> | AllergyIntolerance carries no end date or Outcome; its title is only in the narrative | Hidden only when `resolved`; the title read from the narrative |
| **BUG-46**<a id="bug-46"></a> | The "list reviewed" flag behind "None" / "No Known Allergies" is not exposed | Empty cards read "Nothing Recorded" |
| **BUG-47**<a id="bug-47"></a> | `problem-list-item` omits a problem linked to an encounter, and any inactive row | The card warns that such problems may be missing |
| **BUG-48**<a id="bug-48"></a> | MedicationRequest misreports prescriptions: refills always 0, quantity and strength truncated, form and a bare-number dose dropped | Refills, quantity and strength handled as FR-CARD-RX-1 says |
| **BUG-50**<a id="bug-50"></a> | Encounter `type` is one constant; a class-less encounter sends a CodeableConcept as `class` | The class is shown as the type |
| **BUG-51**<a id="bug-51"></a> | "UTC" dates are the server's wall clock with its current offset, not instants | Dates and times shown as recorded, never converted through the device's time zone |
| **BUG-52**<a id="bug-52"></a> | CareTeam drops member status and note, keeps removed members, may send the provider type as the role | The cells say so; removed members listed |
| **BUG-59**<a id="bug-59"></a> | Immunization is `not-done` for every completion status but Completed; entered-in-error rows are sent | Listed with a note, never hidden; entered in error dropped |
| **BUG-60**<a id="bug-60"></a> | Immunization names the vaccine only by CVX code, with the long name | Long name, "CVX {code}", or "Vaccine name not sent by OpenEMR" |
| **BUG-61**<a id="bug-61"></a> | FHIR exposes no patient photo to a non-admin user | The header shows the silhouette ([FR-HDR-4](#fr-hdr-4)) |

## 15. Screens

**Legacy OpenEMR screens matched (`SCR-`).** SCR-LOGIN (OAuth2 login), SCR-CONSENT (scope consent), SCR-PATSEL
(EHR-launch patient picker), SCR-LOGIN-CORE (staff login), SCR-CHROME (the tabs shell), SCR-PATBAR (the patient
bar), SCR-FINDER (patient finder), **SCR-DASH** (the patient dashboard) and its cards SCR-DASH-ALG (Allergies),
SCR-DASH-PRB (Medical Problems), SCR-DASH-MED (Medications), SCR-DASH-RX (Prescriptions), SCR-DASH-CT (Care Team),
SCR-DASH-VIT (Vitals), SCR-DASH-LAB (Labs), SCR-DASH-IMM (Immunizations), SCR-DASH-APT (Appointments), and
SCR-ENC-HIST (Visit history). The legacy card framework renders one template per card with its own collapse
control and empty state; module buttons and cards are injected through PHP events, which the new app does not
fire. The light and dark colour tokens come from OpenEMR's `style_light` and `style_dark` themes.

**The app's screens (`W-`).**

| ID | Screen |
|---|---|
| W-1, W-1b | Sign in; the signed-out page with a fixed notice per reason |
| W-2 | Patient search |
| W-3, W-3b | The dashboard in landscape; the patient header's states (deceased, not recorded, loading, not authorised) |
| W-4 | The dashboard in portrait |
| W-5 | Card states — loading, empty, error with retry, not authorised, name unavailable, malformed item |
| W-6 | The automatic-logoff warning |
| W-7 | The privacy cover |
| W-8 | The offline shell and "update available" |
| W-9 | The theme menu and the account menu |
| W-10, W-10b | The navigation rail and drawer |
| W-11, W-11b | Patient sections and the "Open in OpenEMR" links |
| W-12, W-12b, W-12c | The item-detail dialog; the switch-patient and sign-out confirmations |
| W-13 | The Patient apps slot |

## 16. The AgentForge module

The OpenEMR module `oe-module-agentforge` connects OpenEMR to the AgentForge clinical copilot, a separate
service. It:

- adds a **Launch AgentForge** button to the patient chart (the demographics page) that starts a SMART on FHIR
  launch of the copilot for that patient, in a modal frame or a new tab (`agentforge_launch_mode`);
- adds a **Day's Agenda** menu item that launches the copilot's roster view (it can be hidden);
- exposes `public/agenda-drilldown-launch.php?patient={uuid}`, a launch keyed by the patient's FHIR id that
  re-checks the user's access, mints the patient-scoped launch and sets the bridge cookie in one top-level
  navigation — the entry the frontend's Patient apps slot uses (API-47);
- runs a **document-ingest background service** that forwards newly uploaded documents in mapped categories to
  the copilot, so it can extract facts before the visit (it does nothing unless an ingest address and a category
  map are set);
- provides **synthetic demo-data seeders** (the AF-DEMO cardiology cohort, appointments, care teams) and a seeder
  for an integration-test `client_credentials` client, both refused in production.

Its configuration is in [DEPLOYMENT.md](DEPLOYMENT.md) §5 and its seeders in the
[module README](interface/modules/custom_modules/oe-module-agentforge/README.md).
