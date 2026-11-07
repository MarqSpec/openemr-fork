#!/bin/sh
# A commit id in /app/BUILD_SHA (only a source upload writes one) is what /bff/health
# reports, over any BUILD_SHA environment variable. The committed file is whitespace only, which
# leaves the environment value alone: the image-build arg the release build passes.
set -eu
if [ -f /app/BUILD_SHA ]; then
    build_sha_file=$(tr -d '[:space:]' < /app/BUILD_SHA)
    if [ -n "${build_sha_file}" ]; then
        BUILD_SHA="${build_sha_file}"
        export BUILD_SHA
    fi
fi
exec "$@"
