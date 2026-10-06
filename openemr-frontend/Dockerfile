# syntax=docker/dockerfile:1.26.0@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
# -----------------------------------------------------------------------------
# openemr-frontend: the SPA's static build served by its token handler (bff/), one origin (PRD Q-7,
# FR-BFF-1). Build context is THIS directory (openemr-frontend/), not the repo root:
#   docker build -t openemr-frontend:local openemr-frontend
# Railway builds the same file server-side from `railway up openemr-frontend --path-as-root`
# (the frontend's staging deploy, frontend:deploy:staging).
#
# No secrets are baked in: OPENEMR_BASE_URL (required) and the rest of bff/.env.example come from the
# platform's environment at run time. The SPA's build reads two optional VITE_* variables, both public,
# per-environment config and never committed files, each a build arg in the spa stage below (Railway passes a
# declared ARG its service variable of the same name): VITE_PATIENT_APPS and VITE_PRIVACY_GRACE_SECONDS
# (whole seconds 0-900, empty or invalid = the 60 s default).
#
# Every image the build pulls is pinned by tag AND digest (never :latest): NODE_IMAGE below and the syntax
# frontend on line 1. The tag says what it is; the digest (the multi-arch index) is what is pulled, so a tag
# rebuilt upstream changes nothing here until someone bumps it. Keep Node 22 (both package.json files say
# engines >=22, and CI's frontend jobs run node:22-alpine). Bump both halves together, never the tag alone:
# DEPLOYMENT.md "Bumping a pinned base image".
# DEPLOYMENT.md "The frontend on Railway"
# -----------------------------------------------------------------------------
ARG NODE_IMAGE=node:22.23.3-alpine3.24@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

# --- The SPA: `vite build` -> /spa/dist -------------------------------------------------------------------
FROM ${NODE_IMAGE} AS spa
WORKDIR /spa
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html vite.config.ts tsconfig.json ./
COPY src ./src
# The PWA manifest and icons: Vite copies public/ into the build unhashed.
COPY public ./public
# FR-APP-1: the patient-apps slot's JSON list; empty = no slot. Public config, not a secret.
ARG VITE_PATIENT_APPS=
# FR-UI-4: seconds hidden before sign-out; empty = 60. Longer leaves PHI covered, not signed out, for longer.
ARG VITE_PRIVACY_GRACE_SECONDS=
RUN npm run build

# --- The token handler: tsc -> /bff/dist ------------------------------------------------------------------
FROM ${NODE_IMAGE} AS bff
WORKDIR /bff
COPY bff/package.json bff/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY bff/tsconfig.json bff/tsconfig.build.json ./
COPY bff/src ./src
RUN npm run build

# --- The token handler's production dependencies only -----------------------------------------------------
FROM ${NODE_IMAGE} AS bff-deps
WORKDIR /bff
COPY bff/package.json bff/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# --- Runtime: non-root, read-only app files, the SPA served from /app/public ------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    BFF_HOST=0.0.0.0 \
    BFF_SPA_DIST_DIR=/app/public
# The service runs `node` only. Drop the base image's package managers - npm/npx, corepack and yarn - so a
# shell in the container cannot fetch and run packages, and fail the build if any is still on PATH.
RUN rm -rf /usr/local/lib/node_modules /opt/yarn-v* \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    && for tool in npm npx corepack yarn yarnpkg; do if command -v "${tool}"; then exit 1; fi; done \
    && node --version
WORKDIR /app
# Owned by root and not writable by the process: the service writes nothing to disk.
COPY --from=bff-deps /bff/node_modules ./node_modules
COPY --from=bff /bff/dist ./dist
COPY bff/package.json ./package.json
COPY --from=spa /spa/dist ./public
# The commit this image is built from, reported by /bff/health as `build` so a post-deploy check can tell the new
# deployment from the old one. Public (the commit is in the repo), not a secret. Two inputs, last so a new commit
# reuses every cached layer above:
#   - BUILD_SHA in this directory. frontend:deploy:staging writes the commit into the upload before `railway up`,
#     so the sha travels with that source. The committed file is only a newline. When the file has a
#     commit id, docker-entrypoint.sh exports it over any BUILD_SHA environment variable — a leftover Railway
#     service variable cannot relabel the image, and a failed deploy cannot leave one behind.
#   - ARG BUILD_SHA, which `frontend:image` and a local `docker build --build-arg` pass. With the empty committed
#     file, that arg is what those builds report. Empty file and empty arg = unknown.
ARG BUILD_SHA=
ENV BUILD_SHA=${BUILD_SHA}
COPY BUILD_SHA docker-entrypoint.sh ./
RUN chmod 755 docker-entrypoint.sh && chmod 644 BUILD_SHA
# The image's own `node` user (uid 1000). exec in the entrypoint leaves Node as pid 1, so it still handles
# SIGTERM itself (bff/src/main.ts drains, then exits).
USER node
EXPOSE 8080
# Liveness only: /bff/ready depends on OpenEMR, and a container must not be killed for OpenEMR being down.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/bff/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "dist/main.js"]
