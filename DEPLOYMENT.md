# Deployment

How to configure, build, deploy, check and roll back the two deployables in this repository — the **OpenEMR
image** (with the AgentForge module inside it) and the **frontend image** (the patient-dashboard SPA served by its
token handler). The AgentForge copilot is a separate service, deployed on its own; this document covers only what
OpenEMR needs to reach it. Requirement and behaviour IDs are in [REQUIREMENTS.md](REQUIREMENTS.md).

**Synthetic data only** in every environment that is not production. No real patient data may reach an environment
before the prerequisites in §7 are met.

## 1. What gets deployed

| Service | Built from | Listens on | Needs |
|---|---|---|---|
| **OpenEMR** | `docker/railway/Dockerfile`, build context the repository root | 80 (HTTP; terminate TLS in front of it) | A MySQL or MariaDB database; a persistent volume at `/var/www/localhost/htdocs/openemr/sites` |
| **Frontend** (SPA + token handler) | `openemr-frontend/Dockerfile`, build context `openemr-frontend/` | `PORT`, 8080 by default | OpenEMR reachable over HTTPS; an OAuth client registered for its origin (§4) |

Each environment (for example staging and production) runs one of each, with its own database, its own frontend
origin and its own OAuth client. Run **exactly one** frontend instance per environment: sessions live in the token
handler's memory ([ARCHITECTURE.md](ARCHITECTURE.md) §6).

## 2. OpenEMR configuration

The container runs `docker/release/openemr.sh`, which on first boot installs OpenEMR into the database (several
minutes — the health check allows 600 s), and on later boots reuses the configured database and volume. Settings are
environment variables:

| Variable | Purpose |
|---|---|
| `MYSQL_HOST`, `MYSQL_PORT` | The database server |
| `MYSQL_ROOT_USER`, `MYSQL_ROOT_PASS` | A database administrator, used for first-time setup |
| `MYSQL_USER`, `MYSQL_PASS`, `MYSQL_DATABASE` | The account and database OpenEMR uses |
| `OE_USER`, `OE_PASS` | The initial OpenEMR administrator, created at first setup — choose a strong password |
| `SWARM_MODE=yes` | Enables the container's leader election and the restore of shared site files; this image expects it on |
| `PORT=80` | Set where the platform routes and health-checks by `PORT`, so its checks reach Apache on port 80 |
| `RUN_DB_UPGRADE=yes` | Keeps `sql_patch.php`, `sql_upgrade.php`, `ippf_upgrade.php` and `acl_upgrade.php` reachable for a manual upgrade; it runs no upgrade itself (§8). Unset afterwards and redeploy, because they stay until a new container replaces the old one — they are unauthenticated by design |
| `TZ` | The time zone the synthetic seed (§5) runs in, `UTC` by default. OpenEMR's own is **Time Zone** under *Administration › Config › Locale*: set that to the clinic's ([BUG-35](REQUIREMENTS.md#bug-35), [BUG-51](REQUIREMENTS.md#bug-51)) |
| `AGENTFORGE_*` | The module's settings and the synthetic seed (§5) |

Upstream's other options (Redis, certificates, Xdebug, `OPENEMR__ENVIRONMENT`, …) are described in
[DOCKER_README.md](DOCKER_README.md) and [`.env.example`](.env.example).

Health check: `GET /interface/login/login.php?site=default` answers 200 (`railway.json` sets the same path and a
600 s timeout). Container logs end first-time setup with `Setup Complete!`.

## 3. Building and tagging the images

Tag every image with the version being released and the commit it was built from, and keep the previous tags: a
rollback (§9) redeploys one of them. The `deploy.sh` adapters (§8) also need a moving `:<environment>` tag on each
image.

```shell
VERSION=1.0.0                                   # the release
SHA=$(git rev-parse --short=12 HEAD)

# OpenEMR, from the repository root
docker build -f docker/railway/Dockerfile -t registry.example.test/openemr-fork:"$VERSION" \
  -t registry.example.test/openemr-fork:sha-"$SHA" .

# The frontend, from the repository root; BUILD_SHA is what /bff/health reports
# Nothing per-environment goes into the image: PATIENT_APPS and PRIVACY_GRACE_SECONDS are set where it runs (§6)
docker build --build-arg BUILD_SHA="$(git rev-parse HEAD)" \
  -t registry.example.test/openemr-frontend:"$VERSION" -t registry.example.test/openemr-frontend:sha-"$SHA" \
  openemr-frontend

docker push --all-tags registry.example.test/openemr-fork
docker push --all-tags registry.example.test/openemr-frontend
```

Before tagging a release, run the gates the [README](README.md) lists — for the frontend `npm run lint`,
`npm run typecheck`, `npm run format:check`, `npm test`, `npm run build`, `npm run check:no-cdn`,
`npm run deps:audit`, `npm run deps:licences` and `npm run test:e2e`, and the same five in `bff/`.

Check a built frontend image before deploying it:

```shell
docker run --rm -d --name fe-check -p 8080:8080 \
  -e OPENEMR_BASE_URL=https://openemr.example.test -e BFF_PUBLIC_ORIGIN=https://frontend.example.test \
  -e OAUTH_CLIENT_ID=synthetic-client-id -e OAUTH_CLIENT_SECRET=replace-with-the-registered-secret \
  registry.example.test/openemr-frontend:"$VERSION"
curl -fsS http://localhost:8080/bff/health        # {"status":"ok","build":"<commit>"}
docker exec fe-check id -u                        # 1000: not root
docker exec fe-check sh -c 'command -v npm'       # nothing: the runtime has no package manager
docker rm -f fe-check
```

### Bumping a pinned base image

The frontend's base image (`NODE_IMAGE`) and the Dockerfile syntax image are pinned by tag **and** digest. To bump
one, pick the new tag, read its multi-arch index digest (`docker buildx imagetools inspect node:<tag>`), change both
halves together — never the tag alone — and rebuild and re-check the image as above. Keep Node 22, which both
`package.json` files require.

## 4. One-time OpenEMR setup for the frontend

Each environment needs this once, and again after the database is reseeded or the frontend's origin changes.

### 4.1 OpenEMR settings
In *Administration › Config › Connectors*, as an administrator:

1. **Enable the Standard FHIR REST API** (`rest_fhir_api`). With every API global off, all of `/oauth2` answers 404
   ([BUG-22](REQUIREMENTS.md#bug-22)). Leave the Standard REST API off.
2. **Site Address** (`site_addr_oath`) = the exact public origin browsers use for OpenEMR — scheme, host, port, no
   trailing slash. OpenEMR builds its issuer and the FHIR `aud` from it and compares them exactly
   ([BUG-17](REQUIREMENTS.md#bug-17)).

Optionally grant the clinicians' role the `admin/users` ACL so practitioner and facility names resolve; without it
the cards read "Name unavailable" ([BUG-10](REQUIREMENTS.md#bug-10), [Q-9](REQUIREMENTS.md#q-9)).

### 4.2 Register the OAuth client
Use the script, not OpenEMR's *Register App* form, which fails for this client ([BUG-26](REQUIREMENTS.md#bug-26)).
It refuses write, `system/` and wildcard scopes and any scope OpenEMR does not advertise
([BUG-11](REQUIREMENTS.md#bug-11)), and derives the redirect URI `<origin>/bff/callback` and the post-logout URI
`<origin>/signed-out`, which OpenEMR matches exactly ([BUG-5](REQUIREMENTS.md#bug-5)). From `openemr-frontend/`,
dry run first (it registers nothing), then register with the secret written **outside** the repository:

```shell
npm ci
npm run oauth:register -- --env production --dry-run \
  --openemr-base-url https://openemr.example.test --frontend-origin https://frontend.example.test
npm run oauth:register -- --env production --secret-out ~/oauth-production.secret \
  --openemr-base-url https://openemr.example.test --frontend-origin https://frontend.example.test
```

The URL flags can be dropped once the environment's entry in
[`config/oauth-clients.json`](openemr-frontend/config/oauth-clients.json) carries them. `--secret-out -` prints the
secret on stdout for piping into a secret store; `--site <id>` serves a multi-site install. The scopes registered are
[`config/oauth-scopes.json`](openemr-frontend/config/oauth-scopes.json) ([INTERFACES.md](INTERFACES.md) §2),
`offline_access` included — without it sessions end after the first hour.

### 4.3 Enable the client
The client is **created disabled** ([BUG-14](REQUIREMENTS.md#bug-14)). In *Administration › System › API Clients*,
open the client the script named (`openemr-frontend (token handler) - <env>`), check its redirect URI, post-logout URI
and scopes, and **Enable Client**. Disable any older client for the same environment ([BUG-27](REQUIREMENTS.md#bug-27)).

### 4.4 Record the id; store the secret
- The **client id** is public: record it as the environment's `clientId` in `config/oauth-clients.json`.
- The **client secret** goes only into the frontend service's secret environment, as `OAUTH_CLIENT_SECRET` — never
  into git, a `VITE_*` variable, the SPA bundle or a log. Delete the `--secret-out` file once stored.

### Re-running safely

| Situation | Do |
|---|---|
| Just checking an environment | `--dry-run` — read-only |
| The script refused | Nothing was created; fix the named cause and run again |
| It failed after printing `client_id=` | The client exists: disable it, then run again with `--allow-new-client` |
| The database was reseeded or restored | Check the API Clients page; if the client is gone, register again with `--allow-new-client`, enable it, and update the id and secret |
| Rotating the secret, a new frontend origin, or a changed scope list | Register a new client with `--allow-new-client`, enable it, switch the id and secret, then disable the old one — OpenEMR never updates a registered client |

### The local dev stack
Upstream's `docker/development-easy` stack serves OpenEMR at `https://localhost:9300` with a self-signed certificate.
**Never disable TLS verification.** Trust that one certificate instead, saved outside the repository:

```shell
openssl s_client -connect localhost:9300 -servername localhost </dev/null 2>/dev/null \
  | openssl x509 > ~/openemr-dev-stack.pem
NODE_EXTRA_CA_CERTS=~/openemr-dev-stack.pem npm run oauth:register -- --env local --dry-run
```

Or, for local only, use the plain-HTTP port (`--openemr-base-url http://localhost:8300`) when the stack's
`site_addr_oath` is `http://localhost:8300`.

### 4.5 Verify
Sign in through the frontend. A refused sign-in lands on `/signed-out?reason=signin_failed` or
`signin_unavailable`, and the token handler's log names the reason: `token_rejected` with `invalid_client` (a wrong
secret, or the client not enabled), `scope_unsupported` (with the missing scopes), `origin_mismatch`
(`OPENEMR_AUTHORIZE_ORIGIN`). `GET /bff/session` lists `grantedScopes`, `offline_access` among them.

## 5. The AgentForge module

The module is registered and enabled automatically when the container first sets up the database; on an existing
database, enable it yourself in Manage Modules. Configure it in OpenEMR under
**Administration › Modules › Manage Modules › Custom Modules › Agent Forge Copilot › gear icon**; values are
stored in the `globals` table and take effect at once. A field left blank falls back to its environment variable,
and otherwise to not configured.

| Setting | Variable | Purpose |
|---|---|---|
| Launch URI | `AGENTFORGE_LAUNCH_URI` | The copilot's per-patient launch endpoint (the chart button) |
| Agenda Launch URI | `AGENTFORGE_AGENDA_LAUNCH_URI` | The copilot's roster endpoint (the Daily Agenda tab); blank reuses the Launch URI |
| Issuer | `AGENTFORGE_ISSUER` | The FHIR issuer the launch is validated against |
| Launch mode | — | A modal frame or a new browser tab |
| Daily Agenda tab | — | Hide or show the tab |
| Ingest URI | `AGENTFORGE_INGEST_URI` | Where the document-ingest service forwards new documents; blank disables ingest |
| Category map | `AGENTFORGE_INGEST_CATEGORY_MAP` | Which document categories are forwarded, and as which document type |

**Every launch address must be one front door.** When the copilot sits behind a reverse proxy that shares an origin
with OpenEMR, point the Launch URI, the Agenda Launch URI and the Issuer at that front door, never at the copilot's or
OpenEMR's own host — a launch whose `/launch` and OAuth callback land on different hosts loses its session cookie.

**SMART-launch setup in OpenEMR** (once per environment, as an administrator):

1. **Site Address** (`site_addr_oath`) = that same front door; it must match the Issuer.
2. Enable **OAuth2 EHR-Launch Authorization Flow Skip** (*Config › Connectors*), so an in-EHR launch reuses the
   OpenEMR session instead of asking for a login.
3. Register one confidential OAuth client per launch flow against the front door
   (`POST /oauth2/default/registration`, `token_endpoint_auth_method: client_secret_post`): the per-patient flow with
   its `…/callback` redirect and patient scopes, the roster flow with its `…/agenda/callback` redirect and `user/`
   scopes. Each lands disabled: enable it in *System › API Clients* and turn on its **Skip EHR Launch Authorization
   Flow** toggle. The ids and secrets are the copilot service's configuration.

**Document ingest** runs as an OpenEMR background service, which the module registers on load (an administrator's
on/off choice is kept); the container forwards the two ingest variables to it (`docker/release/openemr.conf`).
Nothing in the image schedules it: OpenEMR runs background services while a signed-in user has its main screen
open, and tablets on the frontend do not count, so with nobody there it does not run and logs nothing. To run it
regardless, schedule it yourself as the `apache` user, because `bin/console` refuses root: in the webroot,
`su-exec apache php bin/console background:services crontab` prints the entries. The scheduled
job needs the ingest settings too, so set them in the module's form or pass the variables to the job. If
uploaded documents are never forwarded, first confirm it runs, then read the container log for an `AgentForge document ingest skipped` warning,
quoted inside a `Background service subprocess wrote to stderr` line (§10). It names the missing or broken setting,
and tells an unset category map apart from one that is set but unparsable or maps nothing to `lab_pdf` /
`intake_form`. It is logged once per reason, not every run. `AgentForge document ingest
forward failed` names the document id and the HTTP status or exception class; `AgentForge document ingest could not
read a document` names the id and the exception class only (the exception message can quote the file path, so it is
never logged). The document is retried on every later run, because the watermark stops just below it. Every later
document is sent again on each run while it is held: the copilot answers from its hash index, but it is not free (a
quiet clinic re-sends a few files on each run, a busy one many), so fix or re-upload a stuck document promptly.
After 30 counted runs (at least an hour at the two-minute interval) the run gives up and the watermark moves past the
document. Whether a run counts depends on why the document failed. A copilot rejection counts only if the copilot newly
accepted another document in that run; an unreadable file counts only if another file was read in that run; so neither
a copilot outage nor a storage outage (unmounted volume, CouchDB) uses up a document's runs. (A missing encryption key
fails only encrypted documents, so unencrypted files read in the same run make it count.)
A patient with no FHIR UUID, an empty file and a document with no UUID of its own count every run. The error line names
the document id and the cause, and each cause has its own remedy, after which the document must be re-uploaded:
`... gave up on a document the sidecar kept rejecting` (check the copilot), `... whose patient has no FHIR UUID` (give
the patient a UUID), `... whose file could not be read` (check the document storage and its encryption key), `... whose
file is empty` (upload it again with its content), `... that has no UUID of its own` (re-upload it so it gets one). Two
globals back this and need no setting: `agentforge_ingest_watermark` and `agentforge_ingest_retry`
(`<document id>:<counted runs>:<highest id accepted>`, empty when nothing is held back).

**The synthetic seed** runs at boot, only where declared, and never fails the boot. With `SWARM_MODE=yes` it runs
at first-time setup on the `sites` volume and on the boot that upgrades it: every other boot is a follower and skips
it, so a kept volume is reseeded by hand.

| Variable | Effect |
|---|---|
| `AGENTFORGE_SEED_PROVIDER=<username>` | Seed the synthetic AF-DEMO cardiology cohort and its care teams for that provider (created as a no-login scheduling user if absent), then a rolling window of appointments |
| `AGENTFORGE_SEED_APPOINTMENT_DAYS` | The appointment window, in days (default 90) |
| `AGENTFORGE_QA_SYSTEM_CLIENT_ID`, `…_JWKS`, `…_SCOPE` | Create and enable an integration-test `client_credentials` client with that id, public key set and scope |

The whole step is refused when the environment's name is `production` (`RAILWAY_ENVIRONMENT_NAME`), whatever is
declared. Never declare the seed in production. The seeders can also be run by hand; see the
[module README](interface/modules/custom_modules/oe-module-agentforge/README.md).

## 6. Frontend configuration

Runtime settings are environment variables, parsed and validated once at start-up — a bad or missing value stops the
process with a list of every problem, naming the variable and never the value. Every variable, its default and its
rule is in [`openemr-frontend/bff/.env.example`](openemr-frontend/bff/.env.example).

| Variable | Required | Purpose |
|---|---|---|
| `OPENEMR_BASE_URL` | yes | OpenEMR as the token handler reaches it (https; may include a webroot path) |
| `BFF_PUBLIC_ORIGIN` | yes | The origin browsers load the frontend from; the OAuth redirect URIs are built on it |
| `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET` | yes | The client from §4; the secret as a secret variable |
| `BFF_SPA_DIST_DIR` | set by the image | Where the built SPA is (`/app/public`) |
| `PORT`, `BFF_HOST` | no | Default 8080, `0.0.0.0` |
| `OPENEMR_SITE` | no | OpenEMR site id, default `default` |
| `OPENEMR_AUTHORIZE_ORIGIN` | no | The origin the browser is sent to for sign-in, when it differs from `OPENEMR_BASE_URL`'s |
| `BFF_IDLE_TIMEOUT_SECONDS`, `BFF_MAX_SESSION_SECONDS` | no | Session limits: default 900 and 36 000 |
| `BFF_FHIR_TIMEOUT_MS`, `BFF_FHIR_MAX_CONCURRENT`, `BFF_FHIR_MAX_CONCURRENT_PER_SESSION` | no | The FHIR proxy's budget and concurrency: default 30 000, 4, 3 |
| `BFF_OAUTH_TIMEOUT_MS`, `BFF_READY_TIMEOUT_MS`, `BFF_LOG_LEVEL` | no | Upstream budgets and log level |
| `BFF_DEV_INSECURE_COOKIES` | local only | Plain-http cookies for local development; refused in production |

**The SPA's settings** (public, per environment, read by the token handler at start-up and served to the SPA at
`GET /bff/config`, so the same image runs in every environment; a bad value is ignored with a warning in the log
naming the variable and the rule, never stopping start-up):

| Variable | Required | Purpose |
|---|---|---|
| `PATIENT_APPS` | no | The Patient apps slot ([FR-APP-1](REQUIREMENTS.md#fr-app-1)): a JSON list of `{label, url, aclHint?}` naming this environment's OpenEMR; unset, blank or invalid means no slot |
| `PRIVACY_GRACE_SECONDS` | no | Seconds the app may be hidden before it signs out (0–900, default 60, [FR-UI-4](REQUIREMENTS.md#fr-ui-4)) |

**Build argument:** `BUILD_SHA`, the commit `/bff/health` reports — the only one to pass.

**Cache headers.** The token handler sets `Cache-Control` on everything it serves: `index.html` is `no-store`,
fingerprinted `/assets/*` are immutable for a year, other files `no-cache, max-age=0`, and every `/bff/*` response
`no-store`. A CDN or proxy in front must pass these through unchanged and never store a `/bff/*` response.

## 7. Production prerequisites

Software cannot provide these; the practice and the operator do ([NFR-SEC-7](REQUIREMENTS.md#nfr-sec-7)).
Confirm each, and record who confirmed it and when, before the first real patient:

1. **Tablets** are enrolled in the practice's EMM under Android Enterprise: screen lock with a short automatic lock,
   device encryption, remote wipe, screen capture disabled where the practice's review requires it
   ([Q-12](REQUIREMENTS.md#q-12)), other apps and browsers restricted, the OS and Chrome kept updated, the PWA
   provisioned ([Q-13](REQUIREMENTS.md#q-13)), and **the time zone set to the clinic's** and locked
   ([BUG-35](REQUIREMENTS.md#bug-35)). Shared tablets need no device-level login for the app.
2. **One HTTPS origin** for the frontend with a certificate the tablets trust, fixed before the OAuth client is
   registered; OpenEMR on HTTPS with a trusted certificate too. The token handler refuses plain `http` off localhost
   and sends HSTS.
3. **The edge** in front of the frontend passes the cache headers through, rate-limits `POST /bff/login` per client
   address and in total ([Q-14](REQUIREMENTS.md#q-14)), and runs exactly one instance.
4. The **OAuth client** is registered and enabled for the production origin (§4).
5. A signed **business associate agreement** covers every provider hosting the frontend and OpenEMR
   ([Q-11](REQUIREMENTS.md#q-11)).

## 8. Deploying

1. Back up the OpenEMR database and the `sites` volume. If the release upgrades OpenEMR, read *Upgrading OpenEMR*
   below first.
2. Build, tag and push both images (§3).
3. Point each service at the new tag and restart it, OpenEMR first. On any container platform this is the
   platform's own command — for example `kubectl set image …`, `docker compose up -d` with the new tag, or the
   hosting provider's deploy command. `openemr-frontend/scripts/deploy.sh <environment> <version>` is one entry
   point for it. Unset, `DEPLOY_PROVIDER` leaves it a placeholder that deploys nothing and warns; set to `railway`,
   `azure` or `kubectl`, it selects an adapter (*The release scripts' variables*). The script builds and tags
   nothing. The adapters deploy the moving `:<environment>` tag and treat `<version>` only as a label, so a
   **promotion step** in your release process must first point that tag at the release, keeping the tag it
   replaces as `:<environment>-previous`.
4. Smoke-check:
   - OpenEMR: `GET /interface/login/login.php?site=default` answers 200.
   - Frontend: `GET /bff/health` answers `{"status":"ok","build":"<the commit you deployed>"}`, and `GET /bff/ready`
     answers `{"status":"ready"}` (OpenEMR's SMART discovery reachable). `openemr-frontend/scripts/smoke-check.sh
     <environment>` polls `<ENVIRONMENT>_URL` plus `HEALTH_PATH` for about a minute, e.g.
     `PRODUCTION_URL=https://frontend.example.test HEALTH_PATH=/bff/health scripts/smoke-check.sh production`.
   - Sign in through the frontend and open a demo patient (staging only).

A frontend redeploy signs every user out (sessions are in memory); deploy outside clinic hours.

### Upgrading OpenEMR

A release upgrades OpenEMR when it raises `docker/release/upgrade/docker-version` and the repository root's
`docker-version`, which must stay equal: the `fsupgrade-<n>.sh` scripts for the new versions migrate the `sites`
volume and the database. A new `fsupgrade-<n>.sh` must also be named in the `COPY` and `chmod` lists of
`docker/railway/Dockerfile` and `docker/release/Dockerfile`: if it is missing from the image, the container exits at
`Start: Processing fsupgrade-<n>.sh` and the volume stays on the old version.

**The boot runs them, with `SWARM_MODE=yes` (§2) too.** Replicas of the new image contend for one lock on the `sites`
volume, so one runs the upgrade and the rest wait for the volume to reach the new version. In step 3, confirm that one
container's log shows `Upgrade detected: <old> -> <new>` and `OpenEMR upgrade completed successfully`. Then:

- A waiting replica that does not see the upgrade finish within `LEADER_WAIT_TIMEOUT` (default 600 seconds) exits with
  `the upgrade to this image did not finish`, rather than start the new code on the old schema. It needs a restart
  policy to wait again.
- If an upgrade fails, the container exits and the volume stays on the old version. Once the lock has gone
  `LEADER_TIMEOUT` (default 300 seconds) without a heartbeat, a waiting or restarted replica takes over and runs every
  script above that version again.
- Nothing stops replicas of the old image while this runs. If they cannot run on the new schema, scale OpenEMR to one
  replica for the deploy.

`RUN_DB_UPGRADE` plays no part in this. A release that raises `$v_database` in `version.php` and leaves `docker-version`
alone changes only the schema: deploy it with `RUN_DB_UPGRADE=yes`, open `/sql_upgrade.php`, leave the prior release it
selects (it offers no entry for the running release, so `8.1.1` on 8.2.0), run it, then unset the variable and
redeploy, and confirm `/sql_upgrade.php` returns 404. A restart is not enough: setup scripts are removed only on the
first boot of a new container, so the same filesystem keeps them. `sql_upgrade.php` does not replace a `docker-version`
upgrade, because it neither runs the `fsupgrade` scripts' file changes nor updates the volume's `docker-version`.

### The release scripts' variables

`openemr-frontend/scripts/deploy.sh` and `smoke-check.sh` read these. Set them where your release job runs; none is
needed to run the platform's own command by hand.

| Name | Read by | Purpose |
|---|---|---|
| `STAGING_URL` / `PRODUCTION_URL` | `smoke-check.sh` | The smoke check's base URL. Unset, the check passes with a warning that the release is unverified, until `DEPLOY_PROVIDER` selects an adapter; then it fails the release |
| `HEALTH_PATH` | `smoke-check.sh` | The path appended to that URL, `/` when unset. It must answer 2xx |
| `DEPLOY_PROVIDER` | `deploy.sh`, `smoke-check.sh` | `railway`, `azure` or `kubectl`. Unset or `placeholder`, `deploy.sh` deploys nothing and warns |
| `IMAGES` | `deploy.sh` (Railway) | The images to deploy, space-separated, in that order. With one image, leave it unset and set `GITHUB_REPOSITORY` |
| `GITHUB_REPOSITORY` | `deploy.sh` | `<owner>/<repo>`, which the Azure adapter, and the Railway adapter without `IMAGES`, turn into `ghcr.io/<owner>/<repo>`. GitHub Actions sets it |
| `RAILWAY_TOKEN` | `deploy.sh` | A Railway project token scoped to one environment. Keep it a secret; the script sends it in a header and never prints it |
| `RAILWAY_ENVIRONMENT_ID` | `deploy.sh` | Optional: the Railway environment the token must be scoped to. Unset, that environment must be named `staging` or `production`, after the script's first argument |
| `DEPLOY_POLL_SECONDS` / `DEPLOY_POLL_ATTEMPTS` | `deploy.sh` | How long the Railway adapter waits for each deployment, `10` and `60` when unset |
| `AZURE_CONTAINER_APP` | `deploy.sh` | The Azure Container App's base name; the script appends `-<environment>` |
| `KUBE_DEPLOYMENT` | `deploy.sh` | The Kubernetes deployment. Its namespace is the environment |

The Railway adapter needs `curl`, `jq` and `docker buildx` on the machine that runs it, and the others `az` or
`kubectl`.

### The frontend on Railway

The repository is ready for Railway as one option, built on Railway or run from your images. To build on Railway,
leave `DEPLOY_PROVIDER` unset: the `railway` adapter refuses a service that builds from a repository or runs no
image. OpenEMR: `railway.json` builds `docker/railway/Dockerfile` and
health-checks the login page; attach a volume at `/var/www/localhost/htdocs/openemr/sites`, set the §2 variables
(with `PORT=80`), and reference the database service's variables (`${{MySQL.MYSQLHOST}}` and so on). The frontend is
its own service, built from `openemr-frontend/Dockerfile`: `railway up openemr-frontend --path-as-root --service
<service> --environment <environment>`, with the §6 variables set on that service (the client secret as a secret
variable) and `PATIENT_APPS` / `PRIVACY_GRACE_SECONDS` among them. Write the commit into
`openemr-frontend/BUILD_SHA` before uploading so `/bff/health` reports it. Railway's edge must pass the token
handler's cache headers through (§6), and the service must run one replica.

To run your images instead, set `DEPLOY_PROVIDER=railway` and give each service the image `<image>:<environment>`
as its source. The adapter deploys each image in turn, waits for it, and checks that the service runs the digest
the registry holds for that tag.

## 9. Rolling back

Redeploy the previous version's tags — the same step 3 with the earlier tag — and smoke-check again. With a
`deploy.sh` adapter, first point `:<environment>` back at `:<environment>-previous`, then run `deploy.sh` with that
version: the adapter deploys the moving tag, so without this it redeploys the current image and reports the old
version.

- **Frontend:** stateless apart from sessions; rolling back is always safe. Users sign in again.
- **OpenEMR:** the image is safe to roll back as long as the database was not upgraded. A boot changes it only for a
  release that raises `docker-version`, and `/sql_upgrade.php` only when you run it (*Upgrading OpenEMR*, §8).
  After an upgrade an older image may not run against the schema: restore the database and `sites` volume from the backup taken in §8 step 1, then deploy the previous tag.
- **The OAuth client** does not change with a deployment; roll it back only if the frontend's origin changed (§4).

## 10. Monitoring

- **Health:** OpenEMR's login page (above); the frontend's `/bff/health` (liveness — the container's own
  `HEALTHCHECK` uses it) and `/bff/ready` (readiness; it fails when OpenEMR is unreachable, and must never cause a
  restart).
- **Logs:** the token handler writes JSON lines to stdout — method, route shape, `API-` id, status and latency, never
  a body, query string or token. Watch for `session ended: refresh failed`, `signin_failed` and
  `signin_unavailable`, and for 401, 403 and `empty_bundle` counts on the FHIR proxy ([BUG-38](REQUIREMENTS.md#bug-38)).
  OpenEMR's logs are Apache's and PHP's, on the container's stdout and stderr. A background service's own log lines appear there
  inside a `Background service subprocess wrote to stderr` warning, sanitised and truncated to 2,000 characters.
- **Audit:** every clinical read is an OpenEMR API call under the user's identity, in OpenEMR's audit log
  (*Administration › Logs*).
