#!/bin/sh
# The commit id shipped in /app/BUILD_SHA (written into the upload before railway up)
# is what /bff/health reports. It overrides a BUILD_SHA environment variable so a
# leftover Railway service variable cannot relabel this image.
# A whitespace-only file leaves the environment value alone (the image-build arg).
set -eu
if [ -f /app/BUILD_SHA ]; then
    build_sha_file=$(tr -d '[:space:]' < /app/BUILD_SHA)
    if [ -n "${build_sha_file}" ]; then
        BUILD_SHA="${build_sha_file}"
        export BUILD_SHA
    fi
fi
exec "$@"
