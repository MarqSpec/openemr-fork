# Coding agents

Short orientation for AI coding agents working in this repository. The linked documents hold the detail — read them instead of duplicating their content here.

## Read first

- [`README.md`](README.md) — what the system does and how to build, run and test it
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — components, connections and main decisions
- [`REQUIREMENTS.md`](REQUIREMENTS.md) — what the system was built to do
- [`CONVENTIONS.md`](CONVENTIONS.md) — coding and engineering conventions
- [`DEPLOYMENT.md`](DEPLOYMENT.md) — configuration, deploy, rollback and monitoring
- [`INTERFACES.md`](INTERFACES.md) — APIs and other interfaces the code implements

## How to work here

- Keep each change small and easy to review.
- Follow [`CONVENTIONS.md`](CONVENTIONS.md) for coding style and repository rules.
- Update the documents listed above that your change affects.
- Do not commit secrets, credentials, API keys or local `.env` files; follow `.env.example` for configuration shape.

## Build, test and lint

- **Build:** `npm run build`
- **Test:** `npm test`
- **Lint:** `npm run lint`
