#!/usr/bin/env bash
# The check that decides whether a deployment stays or is rolled back: the environment's URL must answer
# 2xx on HEALTH_PATH within about a minute. The URL comes from the repository variable STAGING_URL or
# PRODUCTION_URL. With none set it checks nothing and passes, so a fresh repository's release runs stay green, but it
# warns (and says so in the job summary when GITHUB_STEP_SUMMARY is set) that the release is unverified.
#
# Usage: scripts/smoke-check.sh <staging|production>
set -euo pipefail
env="${1:?environment}"
var="$(tr '[:lower:]' '[:upper:]' <<<"$env")_URL"
url="${!var:-}"
provider="$(printf '%s' "${DEPLOY_PROVIDER:-placeholder}" | tr '[:upper:]' '[:lower:]')"
if [[ -z "$url" ]]; then
  if [[ "$provider" != "placeholder" ]]; then
    msg="${env} is unverified and the release fails: DEPLOY_PROVIDER is ${provider} but ${var} is not set, so no smoke check ran and nothing would roll the deploy back. Set the repository variable ${var} (DEPLOYMENT.md, *The release scripts' variables*)."
    echo "::error::${msg}"
    if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf '> [!CAUTION]\n> %s\n\n' "$msg" >> "$GITHUB_STEP_SUMMARY"; fi
    exit 1
  fi
  msg="${env} is unverified: ${var} is not set, so no smoke check ran and nothing confirms the release is up or would roll it back. Set the repository variable ${var} (DEPLOYMENT.md, *The release scripts' variables*)."
  echo "::warning::${msg}"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf '> [!WARNING]\n> %s\n\n' "$msg" >> "$GITHUB_STEP_SUMMARY"; fi
  exit 0
fi
target="${url%/}${HEALTH_PATH:-/}"
for attempt in $(seq 1 10); do
  if curl --fail --silent --show-error --max-time 10 --output /dev/null "$target"; then
    echo "Smoke check passed: ${target}"
    exit 0
  fi
  echo "attempt ${attempt}/10: ${target} not healthy yet"
  sleep 6
done
echo "::error::Smoke check failed: ${target} did not answer 2xx."
exit 1
