# Conventions

The coding and testing rules the frontend (`openemr-frontend/`, the SPA and its token handler in `bff/`) is written
to. The code's comments cite the sections below by name (*Stack standards*, *Two tiers, one harness*, *Rules*,
*Render-everything unit specs*). The OpenEMR PHP code follows upstream OpenEMR's own standards (`phpcs.xml.dist`,
`phpstan.neon.dist`, `rector.php`; see [CONTRIBUTING.md](CONTRIBUTING.md)). Requirement IDs are in
[REQUIREMENTS.md](REQUIREMENTS.md).

**Synthetic data only, everywhere** — code, tests, fixtures, screenshots, logs. No real patient data, and no secret
in source: configuration comes from the environment.

## Test-first

Write the failing test before the implementation: red, green, refactor. Derive tests from the contract — the use
case (`UC-`), the requirement (`FR-`/`NFR-`), the server call (`API-`) — not from code that does not exist yet. Bug
fixes are regression-first.

- **Vitest + React Testing Library + MSW.** MSW fakes every HTTP dependency; no real network; fake timers wherever
  time matters.
- **Tests are behaviour sentences** — `given … when … then …`, not method names.
- **Test behaviour through the DOM** — query by role, label and text; never assert on state, hooks, class names or
  component internals.
- **Cover error and edge paths:** 401, 403, 5xx, a session ending mid-use, a malformed payload, an empty `Bundle`, a
  partial search, slow responses, offline. Each test names the failure mode it guards.
- Each spec has Vitest's 5 s default; only a whole-dashboard or multi-screen suite passes `HEAVY_SUITE`
  (*Render-everything unit specs* below). Waits give up at `ASYNC_UTIL_TIMEOUT` (4 s); use Testing Library's
  `waitFor`, not `vi.waitFor`.

## Coding standard: Google TypeScript Style Guide

The [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html), enforced by
[`gts`](https://github.com/google/gts) (ESLint + Prettier) with typescript-eslint `strict-type-checked` on top
([NFR-CODE-1](REQUIREMENTS.md#nfr-code-1)). The rules that matter most:

- Named exports only; ES modules, never `namespace`.
- No `any` — use `unknown` and narrow. `const` by default; `===` / `!==`.
- `UpperCamelCase` types, interfaces, classes, enums and components; `lowerCamelCase` values, functions and hooks;
  `CONSTANT_CASE` module-level constants; no `I` prefix on interfaces.
- Interfaces over type aliases for object shapes; no `#private` fields.
- `/** */` JSDoc for documentation, `//` for implementation comments; comments say *why*, never restate *what*.
- File names `snake_case.ts`, except that a component's file is named for the component (`AllergyCard.tsx`).

## Stack standards

- **TypeScript `strict`** plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`; the typecheck is a gate.
- **React 19**, function components and hooks only; the Rules of Hooks enforced by lint.
- **MUI v9 themed from one token file** (`src/theme/tokens.ts`) — the only source of colour, spacing and type; no
  hard-coded colours in components. Touch targets use the `TOUCH_TARGET` token.
- **Typography colour.** A `Typography`'s `color` is one of MUI's own names — `textSecondary`, `textPrimary`,
  `primary`, `error`, `success`, `info`, `warning`, `inherit`. MUI 9.4 ignores a palette path
  (`color="text.secondary"`) or a CSS colour there, and the text keeps its inherited colour. ESLint rejects the ignored
  forms, and `src/theme/secondary_text.test.tsx` reads the colour a card's notice renders in both themes.
  `sx={{color: 'text.secondary'}}` is still right on a `Box`.
- **Server state through TanStack Query** — no fetching in `useEffect`. Query keys come from **one key factory per API
  surface**; mutations invalidate by those keys.
- **A typed API layer, one module per surface** (`src/api/auth/`, `src/api/fhir/`). **Only `src/api/` may touch the
  network**: ESLint forbids `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` and `sendBeacon` everywhere else in
  `src/`, as globals or as a property of any object, and `src/api/network_boundary.test.ts` proves each variant. The
  one exemption, for `fetch` only, is the service worker (`src/pwa/service_worker.ts`), which serves the app shell and
  never answers `/bff`. The layer throws only `ApiError`, whose `failure.kind` a card maps to its state.
- **Parse at the boundary with Zod.** Every response is parsed into a typed value where it enters the API layer.
  Bundles parse per entry: a bad entry becomes a `could-not-display` item whose reason names schema paths and Zod
  issue codes only, never a field value; a search that says it holds more than it sent ends in a `more-not-shown`
  item. A card never drops a non-`ok` item. FHIR types come from `@types/fhir` (R4), and each Zod-inferred type is
  checked as a subset of its R4 definition.
- **Every dashboard card sits in a `CardBoundary`** keyed by the patient, so a card that failed resets when the
  patient changes. End-date rules use `hasNotEnded` (`src/api/openemr_date.ts`), which errs toward showing.
- **Authentication belongs to the token handler.** The SPA never holds a token, a client secret, a PKCE verifier or
  `state`, and never calls `/oauth2/*` or `/apis/*`; it calls only its same-origin `/bff/*` routes. A 401 from
  `/bff/*` means the session is over; a 403 is a per-card not-authorised state.
- **No PHI in logs, the console, error reports or the service-worker cache** — log ids and status codes only.
- **Accessibility: WCAG 2.2 AA**; touch targets ≥ 48 dp; visible focus; labelled controls; colour never the only
  signal.
- Authorisation is OpenEMR's: the app shows what the token's scopes return and never widens it.

**The token handler** (`bff/`) follows the same style, language and gates: Node 22 + TypeScript on Fastify 5,
configuration parsed and validated once at start-up (`src/config.ts`), every route tested with `fastify.inject()`
and OpenEMR faked by MSW — no real network, no real OpenEMR.

## Two tiers, one harness

End-to-end tests are Playwright, in `tests/e2e/`, configured by `playwright.config.ts`.

- **Local tier** — `npm run test:e2e`. Chromium at the two tablet viewports (projects `tablet-landscape` 1280×800 and
  `tablet-portrait` 800×1280) against the **built app on `vite preview`**, which the config builds and starts itself.
  `E2E_SERVER=dev` puts the tablet projects on a Vite dev server instead (local only). **No backend:** it covers what
  the SPA does on its own — the shell, themes, the sign-in and signed-out screens, menus and confirmations, patient
  search, the idle warning and privacy cover on Playwright's fake clock, the dashboard layout, touch-target sizes, and
  an axe scan (WCAG 2.x A/AA) in both themes. The few stubs it uses are layout-only (*Rules*). The `bfcache` project
  runs full Chromium with the back/forward cache on, to prove a page restored by Back after sign-out shows no patient
  data; the `pwa` project holds the service-worker guard ([FR-PWA-2](REQUIREMENTS.md#fr-pwa-2)).
- **Ports.** The config never reuses a running server. The preview listens on `E2E_PREVIEW_PORT` (default 4273) and
  the dev server on `E2E_DEV_PORT` (default 5273), off Vite's own 5173 / 4173, so `npm run dev` can keep running. If
  a port is taken, give the run its own pair, e.g. `E2E_DEV_PORT=5401 E2E_PREVIEW_PORT=4401 npm run test:e2e`.
- **Staging tier** — `tests/e2e/staging/`, against a deployed environment with real OpenEMR and real sign-in. The
  `staging-landscape` and `staging-portrait` projects are added only when `STAGING_BASE_URL` is set; each spec skips
  itself without its credentials (`STAGING_OPENEMR_USER`, `STAGING_OPENEMR_PASSWORD`, and for the patient-app spec
  `STAGING_PATIENT_UUID` and `STAGING_AGENTFORGE_ORIGIN`). Set `PLAYWRIGHT_NO_WEBSERVER=1` to skip the local build. It
  covers cross-site sign-in through the token handler, a storage audit (no PHI, token or OAuth artefact anywhere in
  the browser after sign-in, use and sign-out — [NFR-SEC-1](REQUIREMENTS.md#nfr-sec-1)), axe on the live screens, and
  the AgentForge patient-app launch. A behaviour that needs the backend belongs here — never fake the backend to push
  it into the local tier.
- **Every axe scan goes through `tests/e2e/axe.ts`**, which waits for transitions to settle first, so a fading menu
  never reports a contrast failure that is not there.
- **A contrast check measures the rendered background**, including MUI's dark-mode elevation overlay
  (`renderedColour` in `src/theme/contrast.ts`), not the CSS `background-color`.

## Rules

- **Nothing under test is mocked in the staging tier.** The local tier's stubs are layout-only — `/bff/session`
  answered 401 or with a synthetic clinician; the keep-alive answered with a new expiry; the sign-in and sign-out
  form posts caught to check what the browser sent; `/bff/fhir/*` answered with synthetic fixtures or empty Bundles —
  and none of them decides a backend behaviour.
- **Synthetic data only, credentials from the environment** — never hard-coded, committed, or printed in a trace.
- **Idempotent and tolerant of demo-data gaps:** safe to re-run; assert graceful handling of incomplete records.
- **Each test names the failure mode it guards**, including adversarial cases: asking for what the user is not
  entitled to returns nothing and leaks nothing.
- **Selectors are roles and accessible names only** (`getByRole`, `getByLabel`, `getByText`) — no CSS classes, test
  ids or DOM structure; a control that cannot be found by role and name is an accessibility bug. State is checked the
  same way: a theme by the colour the user sees and the checked menu item, never by reading an attribute.

## Render-everything unit specs

Each unit spec keeps Vitest's 5 s default; there is no project-wide timeout. Only a suite that mounts the whole
dashboard, walks several screens, or pages through full result pages passes `HEAVY_SUITE` (20 s,
`src/test/timeouts.ts`). Make a spec cheap before marking it heavy:

- **Answer every read** — `answerDashboardReads` (`src/test/dashboard.ts`), so no card draws an error the spec did not
  ask for.
- **Few role queries over the whole tree** — look the cards up once with `regionsByName`, wait with a text query
  inside the region that should change, then assert roles once.
- **Narrow by state before name** — `checked`, `selected`, `expanded` and `level` before `name`.
- **Render only what the behaviour needs**; **wait inside the region you mean**; **never assert on a stale
  element** — look a region up again after it re-renders.
- **Paste what the spec only needs entered** (`userEvent.paste`); type only where the keystrokes are the behaviour.
- **One expensive check (an axe run) per spec.**

## Dependencies

Lockfiles are committed and installed with `npm ci`. `npm run deps:audit` fails on a high or critical advisory unless
a dated, reasoned entry in `config/audit-allowlist.json` accepts it; `npm run deps:licences` checks every production
dependency's licence against `config/licence-allowlist.json`; `npm run check:no-cdn` fails a build that references a
script or stylesheet on another origin ([NFR-SEC-8](REQUIREMENTS.md#nfr-sec-8)). Container base images are pinned by
tag and digest.

## Versioning and commits

The frontend's version is `package.json`'s, shown in the app with the short commit. Commit messages follow
[Conventional Commits](https://www.conventionalcommits.org/). A change to behaviour, a server call or configuration
updates [REQUIREMENTS.md](REQUIREMENTS.md), [INTERFACES.md](INTERFACES.md) or [DEPLOYMENT.md](DEPLOYMENT.md) in the
same change ([NFR-DOC-2](REQUIREMENTS.md#nfr-doc-2)).
