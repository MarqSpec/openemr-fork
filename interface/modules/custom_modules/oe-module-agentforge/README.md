# oe-module-agentforge

This module provides the first OpenEMR-side launch integration for AgentForge. It currently exposes a launch URL builder and a module scaffold that can be extended with UI hooks and runtime configuration.

## Demo data seeders

`scripts/` holds the CLI seeders for the **synthetic** AgentForge demo cohort (`AF-DEMO-01..07`) that the
AgentForge copilot and the `openemr-frontend` dashboard are demoed against. Synthetic data only — never real PHI.
Run them inside the OpenEMR container as the web user, never root, and never against a production database:

```sh
su -s /bin/sh apache -c 'php interface/modules/custom_modules/oe-module-agentforge/scripts/<script>.php [options]'
```

| Script | Writes | Idempotent on |
|---|---|---|
| `seed_cardiology_demo.php --provider=<username>` | the cohort: demographics, problems, allergies, prescriptions, today's appointment, two encounters with vitals, a lab panel, and a care team | patient `pubpid`; then "has an encounter", "has a procedure order", and the care-team keys below |
| `seed_demo_appointments.php [--provider=<username>] [--days=N] ...` | upcoming appointments for the existing cohort | (patient, provider, date) |
| `seed_demo_care_teams.php [--provider=<username>]` | a care team for each existing cohort patient (backfills a cohort seeded) | team (patient, team name) · member (team, practitioner, facility) |

Each script takes `--dry-run`. The care team (`openemr-frontend` BUG-30) is one active `care_teams` row,
*AgentForge Demo Cardiology Team*, with one `care_team_member` row: the cardiologist (`users.id`, role
`specialist`, since the patient's first encounter) acting for the first facility. FHIR `CareTeam?patient=` returns
it with a Practitioner and an Organization participant. The seeding rules live in `src/Seed/`
(`DemoCareTeamSeeder`), covered by `tests/Tests/Isolated/Modules/AgentForge/DemoCareTeamSeederTest.php` and the
DB-backed `tests/Tests/Services/Modules/AgentForge/QueryUtilsCareTeamStoreTest.php`.
