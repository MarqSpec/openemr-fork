# Common helpers for BATS tests of OpenEMR Docker bash scripts.
# Source this in test files: load 'helpers'

# Repo root (directory containing docker/, utilities/, tests/)
get_repo_root() {
    local dir
    dir="${BATS_TEST_FILENAME%/*}"
    while [[ -n "$dir" ]] && [[ "$dir" != "/" ]]; do
        [[ -d "${dir}/docker" ]] && [[ -d "${dir}/tests/bats/docker" ]] && echo "$dir" && return 0
        dir="${dir%/*}"
    done
    echo ""
}

# Script directory for a version (8.1.0, binary, flex)
get_script_dir() {
    local version="$1"
    local root
    root="$(get_repo_root)"
    [[ -z "$root" ]] && return 1
    echo "${root}/docker/${version}"
}

# Assert a script exists and has valid syntax for its shebang
assert_script_syntax() {
    local script_path="$1"
    [[ -f "$script_path" ]] || { echo "Script not found: $script_path"; return 1; }
    local shebang
    shebang=$(head -1 "$script_path")
    if [[ "$shebang" =~ ^#!/usr/bin/env\ bash ]] || [[ "$shebang" =~ ^#!/bin/bash ]]; then
        bash -n "$script_path" || { echo "Bash syntax check failed: $script_path"; return 1; }
    elif [[ "$shebang" =~ ^#!/bin/sh ]] || [[ "$shebang" =~ ^#!/usr/bin/env\ sh ]]; then
        # Prefer sh -n; fall back to bash -n only if sh isn't on PATH.
        # `2>/dev/null || true` would have swallowed a real syntax failure here.
        if command -v sh >/dev/null 2>&1; then
            sh -n "$script_path" || { echo "sh syntax check failed: $script_path"; return 1; }
        else
            bash -n "$script_path" || { echo "Bash (sh fallback) syntax check failed: $script_path"; return 1; }
        fi
    else
        bash -n "$script_path" || { echo "Bash syntax check failed: $script_path"; return 1; }
    fi
    return 0
}

# Assert file exists and is readable
assert_file_exists() {
    local path="$1"
    [[ -f "$path" ]] || { echo "File not found: $path"; return 1; }
    [[ -r "$path" ]] || { echo "File not readable: $path"; return 1; }
    return 0
}

# Assert script contains a given pattern
assert_script_contains() {
    local script_path="$1"
    local pattern="$2"
    [[ -f "$script_path" ]] || { echo "Script not found: $script_path"; return 1; }
    grep -q "$pattern" "$script_path" || { echo "Pattern not found in $script_path: $pattern"; return 1; }
    return 0
}

# Assert file (any text file) contains a given pattern
assert_file_contains() {
    local path="$1"
    local pattern="$2"
    [[ -f "$path" ]] || { echo "File not found: $path"; return 1; }
    grep -q "$pattern" "$path" || { echo "Pattern not found in $path: $pattern"; return 1; }
    return 0
}

# Assert directory exists
assert_dir_exists() {
    local path="$1"
    [[ -d "$path" ]] || { echo "Directory not found: $path"; return 1; }
    return 0
}

# Count lines matching pattern in file; assert count >= min
assert_pattern_count_ge() {
    local path="$1"
    local pattern="$2"
    local min="$3"
    [[ -f "$path" ]] || { echo "File not found: $path"; return 1; }
    local count
    # `grep -c` returns exit 1 when it prints "0" matches. Without the `|| true`
    # the prior form `|| echo 0` appended a second "0" producing a non-numeric
    # multi-line count that always failed the -ge comparison.
    count=$(grep -c "$pattern" "$path" 2>/dev/null) || true
    [[ "$count" -ge "$min" ]] || { echo "Pattern $pattern found $count times in $path (expected >= $min)"; return 1; }
    return 0
}

# Extract a top-level bash function (opening `name()` and a `}` at column 0).
extract_bash_function() {
    local file="$1"
    local name="$2"
    awk -v fn="$name" '
        $0 ~ "^" fn "\\(\\)" {p=1}
        p {print}
        p && $0 == "}" {exit}
    ' "$file"
}

# Create an executable command stub in a directory.
# Usage: create_stub_command <stub_dir> <command_name> <script_body>
create_stub_command() {
    local stub_dir="$1"
    local command_name="$2"
    local script_body="$3"
    mkdir -p "$stub_dir" || return 1
    printf '%s\n' "$script_body" > "${stub_dir}/${command_name}" || return 1
    chmod +x "${stub_dir}/${command_name}" || return 1
}

# Run a command with PATH prefixed by the given stub directory.
# Usage: run_with_stubbed_path <stub_dir> <cmd> [args...]
run_with_stubbed_path() {
    local stub_dir="$1"
    shift
    run env PATH="${stub_dir}:$PATH" "$@"
}

# Lays out, under BATS_TEST_TMPDIR, what an image's Dockerfile puts on disk for
# openemr.sh's upgrade gate: /root/docker-version, a stub for each
# fsupgrade-N.sh (it appends N to UPGRADE_RAN), and the webroot code marker only
# if the Dockerfile copies one there (#153). Extracts the real upgrade functions
# into UPGRADE_LIB with /root/ pointed at the fake one, and the swarm election
# into SWARM_LIB.
# Sets IMAGE_VERSION, FAKE_ROOT, FAKE_OE_ROOT, UPGRADE_RAN, UPGRADE_LIB and SWARM_LIB.
# Usage: upgrade_gate_setup <variant>
upgrade_gate_setup() {
    local script_dir script n
    script_dir="$(get_script_dir "$1")" || return 1
    FAKE_ROOT="${BATS_TEST_TMPDIR}/root"
    FAKE_OE_ROOT="${BATS_TEST_TMPDIR}/openemr"
    UPGRADE_RAN="${BATS_TEST_TMPDIR}/fsupgrades-run"
    UPGRADE_LIB="${BATS_TEST_TMPDIR}/upgrade-gate.bash"
    SWARM_LIB="${BATS_TEST_TMPDIR}/swarm.bash"
    mkdir -p "$FAKE_ROOT" "${FAKE_OE_ROOT}/sites/default" || return 1
    : > "$UPGRADE_RAN"
    IMAGE_VERSION="$(tr -d '[:space:]' < "${script_dir}/upgrade/docker-version")"
    printf '%s' "$IMAGE_VERSION" > "${FAKE_ROOT}/docker-version"
    for script in "${script_dir}"/upgrade/fsupgrade-*.sh; do
        n="${script##*/fsupgrade-}"
        n="${n%.sh}"
        printf 'echo %s >> "%s"\n' "$n" "$UPGRADE_RAN" > "${FAKE_ROOT}/fsupgrade-${n}.sh"
    done
    if tr -d '\r' < "${script_dir}/Dockerfile" |
        grep -qE '^COPY upgrade/docker-version /var/www/localhost/htdocs/openemr/docker-version$'; then
        cp "${FAKE_ROOT}/docker-version" "${FAKE_OE_ROOT}/docker-version"
    fi
    {
        extract_bash_function "${script_dir}/openemr.sh" upgrade_pending
        extract_bash_function "${script_dir}/openemr.sh" start_leader_heartbeat
        extract_bash_function "${script_dir}/openemr.sh" stop_leader_heartbeat
        extract_bash_function "${script_dir}/openemr.sh" check_upgrade
        extract_bash_function "${script_dir}/openemr.sh" run_upgrade
    } | sed "s|/root/|${FAKE_ROOT}/|g" > "$UPGRADE_LIB"
    {
        extract_bash_function "${script_dir}/openemr.sh" swarm_wait
        extract_bash_function "${script_dir}/openemr.sh" is_leader_stale
        extract_bash_function "${script_dir}/openemr.sh" try_become_leader
        extract_bash_function "${script_dir}/openemr.sh" update_leader_heartbeat
        extract_bash_function "${script_dir}/openemr.sh" handle_swarm_mode
    } > "$SWARM_LIB"
}

# Runs the upgrade gate the way openemr.sh's step 3 does: set -euo pipefail, as
# the leader, with is_configured answering <configured> (1 or 0). Prints
# GATE_PASSED when check_upgrade returns without killing the script.
# Usage: run_upgrade_gate <configured>
run_upgrade_gate() {
    # shellcheck disable=SC2016  # expanded by the inner bash, not here
    run bash -c '
        set -euo pipefail
        AUTHORITY=yes
        SWARM_MODE=no
        OE_ROOT="$1"
        CONFIGURED="$2"
        is_configured() { echo "${CONFIGURED}"; }
        wait_for_mysql() { :; }
        update_leader_heartbeat() { :; }
        source "$3"
        check_upgrade
        echo GATE_PASSED
    ' _ "$FAKE_OE_ROOT" "$1" "$UPGRADE_LIB"
}

# Writes SWARM_BOOT: one replica's openemr.sh steps 1, 3 and 12 under
# SWARM_MODE=yes, on a configured site, with the wait loops' sleeps cut short. It
# prints BOOTED, its role and any heartbeat left running. A replica holds at the first line
# until SWARM_GO exists, so several can start together. Run it after
# upgrade_gate_setup.
# Usage: swarm_boot_setup
swarm_boot_setup() {
    SWARM_BOOT="${BATS_TEST_TMPDIR}/swarm-boot.bash"
    SWARM_GO="${BATS_TEST_TMPDIR}/swarm-go"
    REPLICA_LOGS="${BATS_TEST_TMPDIR}/replicas"
    mkdir -p "$REPLICA_LOGS" || return 1
    touch "$SWARM_GO"
    cat > "$SWARM_BOOT" <<EOF
set -euo pipefail
until [[ -f "${SWARM_GO}" ]]; do sleep 0.01; done
AUTHORITY=yes
SWARM_MODE=yes
OE_ROOT="${FAKE_OE_ROOT}"
is_configured() { echo 1; }
wait_for_mysql() { :; }
rsync() { :; }
sleep() { command sleep 0.05; }
source "${UPGRADE_LIB}"
source "${SWARM_LIB}"
handle_swarm_mode
check_upgrade
if [[ "\${AUTHORITY}" = "yes" ]]; then
    touch "\${OE_ROOT}/sites/docker-completed"
    rm -f "\${OE_ROOT}/sites/docker-leader"
fi
echo "BOOTED AUTHORITY=\${AUTHORITY} HEARTBEAT=\${LEADER_HEARTBEAT_PID:-none}"
EOF
}

# Starts <count> replicas of SWARM_BOOT together and waits for them. Logs go to
# REPLICA_LOGS. Prints each replica's exit status, one to a line.
# Usage: run_replicas <count>
run_replicas() {
    local i
    local -a pids=()
    rm -f "$SWARM_GO" "${REPLICA_LOGS}"/*
    for (( i = 1; i <= $1; i++ )); do
        bash "$SWARM_BOOT" > "${REPLICA_LOGS}/${i}.log" 2>&1 &
        pids+=("$!")
    done
    touch "$SWARM_GO"
    for i in "${pids[@]}"; do
        wait "$i" && echo 0 || echo "$?"
    done
}
