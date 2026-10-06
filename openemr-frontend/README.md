# openemr-frontend

A **React + TypeScript** reimplementation of OpenEMR's **patient dashboard**, installable as a **PWA** on a
clinician's Android tablet, styled with Material Design (MUI) using OpenEMR's own light and dark theme colours. It
consumes OpenEMR's existing **OAuth2 / OpenID Connect and FHIR R4 APIs** through a small same-origin **token handler**
in [`bff/`](bff/README.md), which holds OpenEMR's confidential OAuth client and every token server-side and proxies
an allow-list of FHIR reads. The OpenEMR PHP backend is not modified for it.

**Data policy:** synthetic data only — never real patient data, anywhere: code, tests, fixtures, screenshots, logs.

What it does and why: [`REQUIREMENTS.md`](../REQUIREMENTS.md). How it fits together:
[`../ARCHITECTURE.md`](../ARCHITECTURE.md). Every server call: [`../INTERFACES.md`](../INTERFACES.md). Deploying it
and registering its OAuth client: [`DEPLOYMENT.md`](../DEPLOYMENT.md). Coding and testing rules:
[`../CONVENTIONS.md`](../CONVENTIONS.md).

## Where to find things

| Path | What's there |
|---|---|
| `src/` | The SPA: `api/` (the only code that touches the network; Zod-parsed FHIR reads and the token handler's routes), `app/` (shell, routing, navigation), `auth/` (sign-in, sign-out, automatic logoff, privacy cover), `features/` (patient search, header, cards, patient apps), `pwa/` (the service worker), `theme/` (OpenEMR's light and dark tokens) |
| `public/` | Copied into the build as is: `manifest.webmanifest` and `icons/` (generated — `npm run icons`) |
| `bff/` | The token handler (Node 22 + TypeScript, Fastify): serves the built SPA and `/bff/*` from one origin — [`bff/README.md`](bff/README.md) |
| `scripts/` | Operator tooling: `icons/` renders OpenEMR's logo into the PWA icon set; `oauth_client/` registers the token handler's OAuth client; `deps/` the dependency audit and licence checks; `deploy.sh` and `smoke-check.sh` ([`DEPLOYMENT.md`](../DEPLOYMENT.md) §8) |
| `config/` | `oauth-scopes.json` (the scope list), `oauth-clients.json` (the client id per environment — never the secret), the audit and licence allow-lists |
| `tests/e2e/` | Playwright end-to-end and axe accessibility specs: a local tier against the built app, and a staging tier against a deployment ([`../CONVENTIONS.md`](../CONVENTIONS.md) *Two tiers, one harness*) |
| `Dockerfile` | The deployable image: the SPA built and served by the token handler, non-root, nothing secret baked in |

## Run it

From `openemr-frontend/`, with Node 22.18 or later:

| Command | What it does |
|---|---|
| `npm ci` | Install exactly what `package-lock.json` pins |
| `npm run dev` | Vite dev server on <http://localhost:5173>, proxying `/bff/*` to the token handler on :8080 |
| `npm run lint` · `npm run typecheck` · `npm run format:check` · `npm test` · `npm run build` | The quality gates |
| `npm run check:no-cdn` | After a build: no script or stylesheet from another origin |
| `npm run deps:audit` · `npm run deps:licences` | `npm audit` (high and critical) and the production-licence check, over this package and `bff/` |
| `npm run icons` | Regenerate `public/icons/` from `../public/images/logos/core/menu/primary/logo.svg`; commit the PNGs |
| `npx playwright install chromium` | One-time: the browser the end-to-end suite drives |
| `npm run test:e2e` | Playwright end-to-end and axe (WCAG 2.x A/AA, light and dark) at 1280×800 and 800×1280; builds the app and starts its own `vite preview` (:4273), never reusing a running one. Report: `npx playwright show-report` |
| `npm run oauth:register -- --env <name> --dry-run` | Check an environment's OpenEMR for the OAuth client registration, without registering ([`DEPLOYMENT.md`](../DEPLOYMENT.md) §4) |

Running the SPA and the token handler together against a local OpenEMR: [`bff/README.md`](bff/README.md)
*Local development*.
