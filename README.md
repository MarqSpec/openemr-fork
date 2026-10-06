# OpenEMR fork with the AgentForge integration and a patient-dashboard PWA

This repository is a fork of [OpenEMR](https://open-emr.org), the free and open-source electronic health
records and practice management application. It carries the whole of OpenEMR, plus two additions:

| Part | Where | What it is |
|---|---|---|
| **OpenEMR** | the repository root (`src/`, `interface/`, `library/`, `apis/`, `sql/`, …) | The upstream PHP application: health records, scheduling, billing, the OAuth2 / OpenID Connect server, the FHIR R4 and standard REST APIs. A small number of upstream files are changed; [ARCHITECTURE.md](ARCHITECTURE.md) §4 lists them. |
| **AgentForge module** | [`interface/modules/custom_modules/oe-module-agentforge/`](interface/modules/custom_modules/oe-module-agentforge/README.md) | An OpenEMR custom module that launches the AgentForge clinical copilot — a separate service, not in this repository — from the patient chart and from a daily-agenda tab, over SMART on FHIR. It also forwards newly uploaded patient documents to the copilot and seeds a synthetic cardiology demo cohort. |
| **Patient-dashboard frontend** | [`openemr-frontend/`](openemr-frontend/README.md) | A React + TypeScript single-page app that reimplements OpenEMR's patient dashboard, installable as a Progressive Web App (PWA) on an Android tablet. It reads only OpenEMR's public OAuth2 and FHIR APIs, through a small same-origin **token handler** (`openemr-frontend/bff/`, Node.js + Fastify) that holds the OAuth client and every token server-side. |

**Data policy.** Everything in this repository — fixtures, seeds, tests, examples — uses synthetic data only.
Never load real patient data into a development or test environment.

## Where to read next

| Document | Holds |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | The components, how they connect, the main design decisions and why |
| [REQUIREMENTS.md](REQUIREMENTS.md) | What the frontend and the module were built to do: use cases (`UC-`), functional (`FR-`) and non-functional (`NFR-`) requirements, and the OpenEMR behaviours (`BUG-`) the code works around |
| [INTERFACES.md](INTERFACES.md) | Every server call the frontend and its token handler make (`API-`), with the OAuth scopes |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Configuration, building the two images, the one-time OpenEMR setup, deploying and rolling back |
| [CONVENTIONS.md](CONVENTIONS.md) | The coding and testing rules the frontend code follows |
| [`openemr-frontend/bff/README.md`](openemr-frontend/bff/README.md) | The token handler in detail: routes, sign-in, session lifecycle, the FHIR read proxy |
| Upstream: [API_README.md](API_README.md), [FHIR_README.md](FHIR_README.md), [DOCKER_README.md](DOCKER_README.md), [`Documentation/`](Documentation/) | OpenEMR's own API, FHIR, Docker and user documentation |

## Build, run and test

### OpenEMR (PHP)

Requirements: PHP 8.2 or later with OpenEMR's extensions, Composer, and Node.js 24 for OpenEMR's own asset build
(the frontend below uses Node 22). From the repository root:

```shell
composer install --no-dev
npm install
npm run build
composer dump-autoload -o
```

The simplest way to run it is the container image this fork deploys, built from the repository root:

```shell
docker build -f docker/railway/Dockerfile -t openemr-fork:local .
```

It needs a MySQL or MariaDB database and the variables in [DEPLOYMENT.md](DEPLOYMENT.md) §2. For a development
environment with a database, use upstream's compose stacks under
[`docker/development-easy/`](docker/development-easy/) (see [DOCKER_README.md](DOCKER_README.md)).

Tests: OpenEMR's PHPUnit configuration `phpunit-isolated.xml` runs the suites that need no database
(`tests/Tests/Isolated/`), and `phpunit.xml` the ones that do (`tests/Tests/Unit/`, `tests/Tests/Services/`, …).
The AgentForge module's tests are in those trees under `Modules/AgentForge/`:

```shell
composer install
vendor/bin/phpunit -c phpunit-isolated.xml --filter AgentForge
```

### The AgentForge module

The module ships inside the OpenEMR image and is registered and enabled automatically on first boot. Its
settings (the copilot's launch addresses, the issuer, the document-ingest address and category map) are entered
in OpenEMR under **Administration › Modules › Manage Modules › Custom Modules › AgentForge Launch Integration ›
gear icon**, or given as environment variables ([DEPLOYMENT.md](DEPLOYMENT.md) §5). The demo-data seeders and
how to run them are in the [module README](interface/modules/custom_modules/oe-module-agentforge/README.md).

### The patient-dashboard frontend

Requirements: Node.js 22.18 or later. From `openemr-frontend/`:

| Command | What it does |
|---|---|
| `npm ci` | Install exactly what `package-lock.json` pins |
| `npm run dev` | Vite dev server on <http://localhost:5173>; it proxies `/bff/*` to the token handler on :8080 |
| `npm run typecheck` | TypeScript, strict, over the app and its scripts |
| `npm run lint` · `npm run format:check` | ESLint (Google TypeScript Style via `gts`) and Prettier |
| `npm test` | Unit and component tests (Vitest, React Testing Library, MSW) — no network |
| `npm run build` | The production build in `dist/` |
| `npm run test:e2e` | Playwright end-to-end and axe accessibility tests against the built app (first time: `npx playwright install chromium`) |
| `npm run deps:audit` · `npm run deps:licences` | `npm audit` (high and critical) and the production-licence check, over both packages |
| `npm run check:no-cdn` | After a build: fails if it references a script or stylesheet on another origin |
| `npm run icons` | Regenerate the PWA icons in `public/icons/` from OpenEMR's logo |
| `npm run oauth:register -- --env <name>` | Register the token handler's OAuth client with an OpenEMR ([DEPLOYMENT.md](DEPLOYMENT.md) §4) |

The token handler, from `openemr-frontend/bff/`: `npm ci`, then `npm run lint`, `npm run typecheck`,
`npm run format:check`, `npm test`, `npm run build`, and `npm start` with the variables in
[`bff/.env.example`](openemr-frontend/bff/.env.example) exported. Running both locally is described in the
[token handler README](openemr-frontend/bff/README.md) *Local development*.

The frontend's container image (the SPA served by the token handler) is built from `openemr-frontend/`:

```shell
docker build -t openemr-frontend:local openemr-frontend
```

## About OpenEMR

OpenEMR features fully integrated electronic health records, practice management, scheduling, electronic
billing, internationalization and a large community. It runs on Windows, Linux, macOS and other platforms.

- **Upstream project and source:** <https://github.com/openemr/openemr> and <https://open-emr.org>.
- **Documentation and forums:** the [OpenEMR website](https://open-emr.org), the
  [community forum](https://community.open-emr.org/) and [chat](https://www.open-emr.org/chat/).
- **Support:** community and professional support are listed in the
  [OpenEMR Support Guide](https://open-emr.org/wiki/index.php/OpenEMR_Support_Guide).
- **Bugs in OpenEMR itself** go to the [upstream issue tracker](https://github.com/openemr/openemr/issues);
  security vulnerabilities in OpenEMR follow upstream's
  [security policy](https://github.com/openemr/openemr/security/policy).
- **Contributing upstream:** see [CONTRIBUTING.md](CONTRIBUTING.md).

OpenEMR exists thanks to all the people who have contributed to it; its sponsors are listed on the
[OpenEMR website](https://www.open-emr.org/wiki/index.php/OpenEMR_Certification_Stage_III_Meaningful_Use#Major_sponsors).

## Licence

This repository is a derivative work of OpenEMR and is distributed under the **GNU General Public License,
version 3** — see [LICENSE](LICENSE). The upstream copyright and licence notices in each file are kept as they
are, and the frontend's `package.json` files declare the same licence (`GPL-3.0`). This repository is the
complete corresponding source; third-party dependencies are pinned by `composer.lock` and the two
`package-lock.json` files, each under its own licence.
