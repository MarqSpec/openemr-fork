#!/usr/bin/env bash
# Tell the host to run the image for this environment. The promotion step calls it with the version
# being deployed, and again with the previous version to roll back; exit non-zero on failure.
#
# CI builds each image once and pushes :X.Y.Z to GHCR, then the promotion step moves :staging / :production
# and :<environment>-previous. This script does not build. The host only pulls and runs a tag.
#
# DEPLOY_PROVIDER selects the adapter (repository or environment variable, lowercase):
#   unset or placeholder — warn and exit 0, so a fresh repository's release stays green
#   railway             — the current adapter (below): deploys every image, waits for each deployment and
#                         checks the digest it runs. Azure and kubectl are the alternatives
# Credentials come from the job's environment, never from this file, and this script never prints them.
# Once a provider is selected, a missing command fails the release instead of warning.
# Rollback is the same command: the promotion step has re-pointed :<environment> at :<environment>-previous
# and calls this script with that image's version. Do not roll back from the host's UI.
#
# Usage: scripts/deploy.sh <staging|production> <version>
set -euo pipefail
env="${1:?environment}"; version="${2:?version}"

case "$env" in
  staging|production) ;;
  *)
    echo "unknown environment '${env}'" >&2
    exit 2
    ;;
esac

# Empty and "placeholder" are the same: the repository has not chosen a host yet.
provider="$(printf '%s' "${DEPLOY_PROVIDER:-placeholder}" | tr '[:upper:]' '[:lower:]')"

warn_placeholder() {
  msg="Nothing was deployed to ${env}: scripts/deploy.sh is still the placeholder, so ${version} is tagged :${env} but runs nowhere, and a rollback deploys nothing either. Put the hosting command in scripts/deploy.sh."
  echo "::warning::${msg}"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf '> [!WARNING]\n> %s\n\n' "$msg" >> "$GITHUB_STEP_SUMMARY"; fi
}

fail_closed() {
  echo "::error::DEPLOY_PROVIDER is ${provider} but ${1} The release fails instead of warning (DEPLOYMENT.md §8)."
  exit 1
}

# --- Railway -------------------------------------------------------------------------------------------------------
# Each image runs on its own Railway service, the one whose source is the image's moving tag <image>:<environment>,
# which the promotion step has just pointed at the release (or, for a rollback, back at :<environment>-previous). Before
# deploying anything the adapter refuses:
#   - a RAILWAY_TOKEN scoped to another Railway environment;
#   - a service in that environment that builds from a repository or runs no image: nothing is built for an
#     environment, so every service there runs an image a release built;
#   - an image in IMAGES that no service runs, or that more than one service runs (a service that runs another
#     tag of the image is named, with the source to point it at);
#   - a tag the registry has no digest for.
# It then starts a new deployment of each service, in IMAGES order, and polls it until it is SUCCESS, or SLEEPING (a
# serverless service that started and then slept). FAILED, CRASHED, REMOVED, REMOVING, SKIPPED, and NEEDS_APPROVAL or
# WAITING (an approval no release can give), or no success within DEPLOY_POLL_ATTEMPTS polls, fail the deploy and
# deploy nothing after it; the promotion step then rolls the environment back. A poll Railway does not answer is asked again,
# up to RAILWAY_POLL_TRIES times in a row; the deploy itself is never sent twice. A deployment that succeeded must
# run the digest the registry holds for its tag.
# It talks to Railway's public GraphQL API with curl and jq, and reads the registry with docker buildx.
#
#   IMAGES                 space-separated image names, as the promotion step takes them; deployed in this order. A
#                          repository with one image can leave it unset and set GITHUB_REPOSITORY (owner/repo)
#   RAILWAY_TOKEN          the Railway project token of that environment: a GitHub environment secret, never a value
#                          in this file. It goes in a request header curl reads from its standard input, never
#                          on a command line, and nothing prints it
#   RAILWAY_ENVIRONMENT_ID optional: the token must be scoped to this Railway environment. Unset, the Railway
#                          environment must be named after the environment this deploys to, the script's first
#                          argument (staging or production), whatever the GitHub environment is called
#   DEPLOY_POLL_SECONDS    wait between status polls (default 10)
#   DEPLOY_POLL_ATTEMPTS   polls before a deployment counts as failed (default 60: ten minutes)
RAILWAY_API="https://backboard.railway.com/graphql/v2"
RAILWAY_POLL_TRIES=3
railway_tail="Nothing was deployed."
railway_retry=""

# railway_fail writes to fd 3, the script's own stdout, so a refusal raised inside $(railway_gql ...) reaches the
# log instead of the variable being assigned. While railway_retry is set, the call is asked again: a warning.
railway_fail() {
  if [[ -n "$railway_retry" ]]; then
    echo "::warning::$* ${railway_retry}" >&3
  else
    echo "::error::$* ${railway_tail}" >&3
  fi
  exit 1
}

# railway_gql <request body> <jq filter>: what the filter makes of the answer's data, as raw text. Fails on a failed
# request, an answer that is not JSON, or one carrying GraphQL errors. One jq reads each answer: under Git Bash every
# process costs a fraction of a second. curl reads the token's header from its standard input (`-H @-`), fed by a
# here-string: `set -x` does not trace one, so a debug run never prints the token. Not `-H @<(...)`: the native
# curl.exe of Git Bash on Windows cannot open the /proc/<pid>/fd path that names, and a manual rollback runs there.
# The body is an argument, so nothing else in the call reads standard input.
railway_gql() {
  local answer data
  if ! answer="$(curl --silent --show-error --fail-with-body --max-time 30 -X POST "$RAILWAY_API" \
      -H 'Content-Type: application/json' -H @- \
      --data-binary "$1" 2>&1 <<<"Project-Access-Token: ${RAILWAY_TOKEN}")"; then
    railway_fail "The Railway API request failed: ${answer:0:300}."
  fi
  if ! data="$(jq -r "if type != \"object\" then error(\"not an object\")
      elif ((.errors // []) | length) > 0 then \"errors: \" + (.errors | tojson) else (.data | $2) end" \
      <<<"$answer" 2>/dev/null)"; then
    railway_fail "The Railway API answered with something other than a JSON object: ${answer:0:200}."
  fi
  data="${data//$'\r'/}"   # a Windows jq ends each line with a CR
  [[ "$data" != 'errors: '* ]] || railway_fail "The Railway API answered with ${data}."
  printf '%s\n' "$data"
}

# railway_json <var> <value>: the value as a JSON string, into the variable. Railway's ids need only \ and " escaped.
railway_json() {
  local v="${2//\\/\\\\}"
  printf -v "$1" '"%s"' "${v//\"/\\\"}"
}

# railway_digests <ref>: the digests a deployment of the tag may run, space-separated: the tag's own and, when the
# tag is an index, its linux/amd64 image's, since Railway runs linux/amd64. Empty when the registry has none.
railway_digests() {
  local manifest digests
  manifest="$(docker buildx imagetools inspect "$1" --format '{{json .Manifest}}' 2>/dev/null)" || return 0
  digests="$(jq -r '[.digest // empty] + [(.manifests // [])[]
    | select(.platform.os == "linux" and .platform.architecture == "amd64") | .digest] | join(" ")' \
    <<<"$manifest" 2>/dev/null)" || return 0
  printf '%s' "${digests//$'\r'/}"
}

# ghcr_name: ghcr.io/<owner>/<repo> from GITHUB_REPOSITORY, lower case: the registry refuses a reference with capitals,
# and GITHUB_REPOSITORY keeps the owner's. (The scaffold lower-cases the IMAGES it writes into the workflows.)
ghcr_name() { printf 'ghcr.io/%s' "$(printf '%s' "$GITHUB_REPOSITORY" | tr '[:upper:]' '[:lower:]')"; }

deploy_railway() {
  [[ -n "${RAILWAY_TOKEN:+set}" ]] || fail_closed "RAILWAY_TOKEN is not set."   # :+set, so set -x never traces it
  local -a images=()
  if [[ -n "${IMAGES:-}" ]]; then
    read -ra images <<<"$IMAGES"
  elif [[ -n "${GITHUB_REPOSITORY:-}" ]]; then
    images=("$(ghcr_name)")
  fi
  [[ "${#images[@]}" -gt 0 ]] || fail_closed "neither IMAGES nor GITHUB_REPOSITORY is set, so there is no image to deploy."
  local poll="${DEPLOY_POLL_SECONDS:-10}" attempts="${DEPLOY_POLL_ATTEMPTS:-60}"
  [[ "$poll" =~ ^[0-9]+$ ]] || fail_closed "DEPLOY_POLL_SECONDS is '${poll}', not a whole number of seconds."
  [[ "$attempts" =~ ^[1-9][0-9]*$ ]] || fail_closed "DEPLOY_POLL_ATTEMPTS is '${attempts}', not a positive whole number."
  exec 3>&1

  # Resolve everything before deploying anything. One line each: the token's environment id and name, the first
  # service there that builds from a repository or runs no image, and every service, as JSON.
  local token env_id env_name built instances
  # shellcheck disable=SC2016  # $name and $nodes are jq's, not the shell's
  token="$(railway_gql '{"query":"query { projectToken { projectId environmentId environment { name serviceInstances { edges { node { serviceId serviceName source { image repo } } } } } } }"}' \
    '.projectToken | (.environment.name // "") as $name | [(.environment.serviceInstances.edges // [])[].node] as $nodes
    | (.environmentId // ""), $name,
      ([$nodes[] | select(.source.repo != null or .source.image == null)
        | "\(.serviceName) in \($name) " + (if .source.repo != null then "builds from \(.source.repo)" else "runs no image" end)]
       | first // ""), ($nodes | tojson)')"
  { IFS= read -r env_id; IFS= read -r env_name; IFS= read -r built; IFS= read -r instances; } <<<"$token"
  if [[ -n "${RAILWAY_ENVIRONMENT_ID:-}" ]]; then
    [[ "$env_id" == "$RAILWAY_ENVIRONMENT_ID" ]] \
      || railway_fail "RAILWAY_TOKEN is scoped to the Railway environment '${env_name}' (${env_id}), not to RAILWAY_ENVIRONMENT_ID ${RAILWAY_ENVIRONMENT_ID}."
  else
    [[ "$env_name" == "$env" ]] \
      || railway_fail "RAILWAY_TOKEN is scoped to the Railway environment '${env_name}', not '${env}'. Set RAILWAY_ENVIRONMENT_ID when the Railway environment has another name."
  fi
  [[ -z "$built" ]] || railway_fail "${built}: every service there runs an image, and nothing is built for an environment."

  # Each image's one service: the one whose source is <image>:<environment>. A service whose source is another tag or
  # digest of the image (the pinned <image>:X.Y.Z the adapter once set, say) is named in the refusal.
  local -a names=() ids=() refs=() accepted=()
  local img ref count found id elsewhere digests
  for img in "${images[@]}"; do
    ref="${img}:${env}"
    IFS='|' read -r count found id elsewhere < <(jq -r --arg ref "$ref" --arg img "$img" '
      [.[] | select(.source.image == $ref)] as $runs
      | [.[] | select(.source.image != $ref and ((.source.image // "") | startswith($img + ":") or startswith($img + "@")))
          | "service \(.serviceName) runs \(.source.image)"] as $other
      | "\($runs | length)|\($runs | map(.serviceName) | join(", "))|\($runs[0].serviceId // "")|\($other | join(", "))"' \
      <<<"$instances")
    elsewhere="${elsewhere%$'\r'}"
    [[ "$count" != 0 || -z "$elsewhere" ]] \
      || railway_fail "No Railway service in ${env_name} runs ${ref}: ${elsewhere}; point its source at ${ref}."
    [[ "$count" != 0 ]] || railway_fail "No Railway service in ${env_name} runs ${ref}."
    [[ "$count" == 1 ]] || railway_fail "More than one Railway service in ${env_name} runs ${ref}: ${found}."
    digests="$(railway_digests "$ref")"
    [[ -n "$digests" ]] || railway_fail "The registry has no digest for ${ref}."
    names+=("$found"); ids+=("$id"); refs+=("$ref"); accepted+=("$digests")
  done

  # Deploy each service in turn, wait for it, and check what it runs. A failure stops the images after it.
  local i name body deployment query state status running n try service_json env_json deployment_json
  for i in "${!refs[@]}"; do
    name="${names[$i]}"; ref="${refs[$i]}"
    railway_tail="Nothing after it was deployed."
    railway_json service_json "${ids[$i]}"; railway_json env_json "$env_id"
    # shellcheck disable=SC2016  # $s and $e are GraphQL's, not the shell's
    printf -v body '{"query":"mutation ($s: String!, $e: String!) { serviceInstanceDeployV2(serviceId: $s, environmentId: $e) }","variables":{"s":%s,"e":%s}}' \
      "$service_json" "$env_json"
    deployment="$(railway_gql "$body" '.serviceInstanceDeployV2 // ""')"   # its own assignment, so a refusal stops here
    [[ -n "$deployment" ]] || railway_fail "Railway started no deployment of ${name}."
    echo "Deploying ${ref} on ${name} in ${env_name}: deployment ${deployment}"

    railway_json deployment_json "$deployment"
    # shellcheck disable=SC2016  # $id is GraphQL's, not the shell's
    printf -v query '{"query":"query ($id: String!) { deployment(id: $id) { status meta } }","variables":{"id":%s}}' \
      "$deployment_json"
    for ((n = 1; n <= attempts; n++)); do
      # A poll Railway does not answer is asked again, RAILWAY_POLL_TRIES times in a row at most: one bad answer is
      # not a failed deployment.
      for ((try = 1; ; try++)); do
        if (( try < RAILWAY_POLL_TRIES )); then
          railway_retry="Asking again (try ${try} of ${RAILWAY_POLL_TRIES})."
        else
          railway_retry="That was try ${try} of ${RAILWAY_POLL_TRIES}."
        fi
        if state="$(railway_gql "$query" '"\(.deployment.status // "")|\(.deployment.meta.imageDigest // "")"')"; then
          railway_retry=""
          break
        fi
        railway_retry=""
        (( try < RAILWAY_POLL_TRIES )) \
          || railway_fail "Railway did not answer a poll of ${name} deployment ${deployment} ${try} times in a row."
        sleep "$poll"
      done
      IFS='|' read -r status running <<<"$state"
      case "$status" in
        SUCCESS|SLEEPING) break ;;   # SLEEPING: it started, then slept; the digest check below still holds it
        FAILED|CRASHED|REMOVED|REMOVING|SKIPPED|NEEDS_APPROVAL|WAITING)
          railway_fail "${name} deployment ${deployment} ended ${status}." ;;
      esac
      if (( n == attempts )); then
        railway_fail "${name} deployment ${deployment} did not succeed after ${attempts} polls ${poll} seconds apart (last status ${status:-unknown})."
      fi
      sleep "$poll"
    done

    [[ -n "$running" && " ${accepted[$i]} " == *" ${running} "* ]] \
      || railway_fail "${name} runs ${running:-an unknown digest}, not ${accepted[$i]// / or } (${ref})."
    echo "Deployed ${version} to ${env}: ${name} runs ${ref} (${running}), deployment ${deployment}."
    if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
      echo "- \`${name}\` runs \`${ref}\` (\`${running}\`), deployment \`${deployment}\`" >> "$GITHUB_STEP_SUMMARY"
    fi
  done
}

# Alternative: Azure Container Apps. The promotion step has already moved the :<env> tag, including a
# rollback onto :<env>-previous, so the app pulls that moving tag. AZURE_CONTAINER_APP is the app's
# base name; the environment is appended, as in "<app>-${env}".
deploy_azure() {
  [[ -n "${AZURE_CONTAINER_APP:-}" ]] || fail_closed "AZURE_CONTAINER_APP is not set."
  [[ -n "${GITHUB_REPOSITORY:-}" ]] || fail_closed "GITHUB_REPOSITORY is not set."
  az containerapp update --name "${AZURE_CONTAINER_APP}-${env}" \
    --image "$(ghcr_name):${env}"
}

# Alternative: Kubernetes. The deployment pulls the moving :<env> tag (already moved by the promotion step)
# when it restarts. KUBE_DEPLOYMENT is the deployment name; the namespace is the environment.
deploy_kubectl() {
  [[ -n "${KUBE_DEPLOYMENT:-}" ]] || fail_closed "KUBE_DEPLOYMENT is not set."
  kubectl -n "${env}" rollout restart "deployment/${KUBE_DEPLOYMENT}"
  kubectl -n "${env}" rollout status "deployment/${KUBE_DEPLOYMENT}"
}

case "$provider" in
  placeholder) warn_placeholder ;;
  railway) deploy_railway ;;
  azure) deploy_azure ;;
  kubectl) deploy_kubectl ;;
  *) fail_closed "scripts/deploy.sh has no adapter named '${provider}'." ;;
esac
