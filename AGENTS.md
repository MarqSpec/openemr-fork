# Guide for coding agents

This repository is a public fork of OpenEMR with additional frontend and module work. Use the documents below for context; do not guess at architecture or API behaviour when a linked file answers the question.

## Documentation map

| Path | Use it for |
|------|------------|
| [README.md](README.md) | Overview, build/run/test entry points, and where fork-specific pieces live |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to propose changes, commit format, review expectations, and upstream workflow |
| [ARCHITECTURE.md](ARCHITECTURE.md) | How components connect and major design decisions |
| [CONVENTIONS.md](CONVENTIONS.md) | Frontend and token-handler coding and testing rules |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Configuration, images, deploy, and rollback |
| [INTERFACES.md](INTERFACES.md) | OAuth/FHIR and BFF API calls the frontend makes |
| [REQUIREMENTS.md](REQUIREMENTS.md) | Functional and non-functional requirements and tracked workarounds |
| [API_README.md](API_README.md) | OpenEMR standard REST API |
| [FHIR_README.md](FHIR_README.md) | OpenEMR FHIR R4 API |
| [DOCKER_README.md](DOCKER_README.md) | Docker-based development and production image notes |
| [README-Isolated-Testing.md](README-Isolated-Testing.md) | PHPUnit isolated suite (no database) |
| [docs/](docs/) | Release and Docker migration notes for this fork |
| [Documentation/](Documentation/) | Upstream OpenEMR user and technical documentation |

Module- and app-specific READMEs under `interface/modules/custom_modules/` and `openemr-frontend/` supplement the table above when you touch those trees.

## Commands agents should use

Run the real commands from the repo root unless a subdirectory README says otherwise.

**OpenEMR (PHP + assets)** — after `composer install` and `npm install`:

```shell
npm run build
composer code-quality          # phpcs, phpstan, rector-check, and related checks
composer phpunit-isolated      # PHPUnit via phpunit-isolated.xml
vendor/bin/phpunit -c phpunit-isolated.xml --filter '<SuiteOrClass>'
npm run lint:js
npm run stylelint
npm run test:js
```

**Patient-dashboard frontend** — from `openemr-frontend/` (see [README.md](README.md)): `npm ci`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`. Token handler checks live under `openemr-frontend/bff/`.

Prefer targeted test and lint runs for the files you change; run broader suites when your change crosses layers.

## Working norms

- Keep diffs small and focused; one logical change per pull request when possible.
- Follow [CONVENTIONS.md](CONVENTIONS.md) for frontend work and [CONTRIBUTING.md](CONTRIBUTING.md) for process, commits (`type(scope): description`), and PHP quality gates.
- Use **synthetic data only** in code, tests, fixtures, and examples — never real PHI.
- **Never commit secrets** (API keys, OAuth client secrets, credentials, private keys, or production connection strings). Use environment variables and existing `.env.example` patterns.
- Do not add or rely on undocumented internal-only tooling; stay within what this repository and its linked docs describe.
