# syntax=docker/dockerfile:1.26.0@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
# -----------------------------------------------------------------------------
# openemr-frontend: the SPA's static build served by its token handler (bff/), one origin (PRD Q-7,
# FR-BFF-1). Build context is THIS directory (openemr-frontend/), not the repo root:
#   docker build -t openemr-frontend:local openemr-frontend
# A push to `staging` builds and publishes it (.github/workflows/release-images.yml); Railway runs that
# published image, deployed by agent-forge.
#
# Nothing per-environment and nothing secret is baked in, so one image runs in every environment:
# OPENEMR_BASE_URL (required) and the rest of bff/.env.example come from the platform's environment at run time -
# including the SPA's own settings, PATIENT_APPS and PRIVACY_GRACE_SECONDS, which the token
# handler serves to the SPA at /bff/config.
#
# Every image the build pulls is pinned by tag AND digest (never :latest): NODE_IMAGE below and the syntax
# frontend on line 1. The tag says what it is; the digest (the multi-arch index) is what is pulled, so a tag
# rebuilt upstream changes nothing here until someone bumps it. Keep Node 22 (both package.json files say
# engines >=22). Bump both halves together, never the tag alone:
# DEPLOYMENT.md "Bumping a pinned base image".
# DEPLOYMENT.md "The frontend on Railway"
# -----------------------------------------------------------------------------
ARG NODE_IMAGE=node:22.23.4-alpine3.24@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914

# --- The SPA: `vite build` -> /spa/dist -------------------------------------------------------------------
FROM ${NODE_IMAGE} AS spa
WORKDIR /spa
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html vite.config.ts tsconfig.json ./
COPY src ./src
# The PWA manifest and icons: Vite copies public/ into the build unhashed.
COPY public ./public
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
#   - ARG BUILD_SHA, which the release build, the image check and a local `docker build --build-arg BUILD_SHA=<commit>`
#     pass. With the empty committed file, that arg is what those builds report. Empty file and empty arg = unknown.
#   - BUILD_SHA in this directory: only a newline in git. A commit id written into it (the retired `railway up`
#     uploads did) is exported by docker-entrypoint.sh over any BUILD_SHA environment variable.
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
