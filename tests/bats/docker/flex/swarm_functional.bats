# BATS: flex swarm leader election — heartbeat during build and AUTHORITY skip
# Extracts the swarm functions from docker/flex/openemr.sh and runs them against a
# temp sites volume. No Docker, no fake clock beyond file mtimes.

load '../helpers'

setup() {
    SCRIPT_DIR="$(get_script_dir flex)"
    [[ -f "${SCRIPT_DIR}/openemr.sh" ]]
    TEST_ROOT="$(mktemp -d)"
    SWARM_LIB="${TEST_ROOT}/swarm-lib.sh"
    {
        echo 'set -euo pipefail'
        extract_bash_function "${SCRIPT_DIR}/openemr.sh" is_leader_stale
        extract_bash_function "${SCRIPT_DIR}/openemr.sh" try_become_leader
        extract_bash_function "${SCRIPT_DIR}/openemr.sh" update_leader_heartbeat
        extract_bash_function "${SCRIPT_DIR}/openemr.sh" start_leader_heartbeat
        extract_bash_function "${SCRIPT_DIR}/openemr.sh" stop_leader_heartbeat
        extract_bash_function "${SCRIPT_DIR}/openemr.sh" swarm_wait
        extract_bash_function "${SCRIPT_DIR}/openemr.sh" wait_for_swarm_completion
        echo 'is_configured() { echo 0; }'
    } > "${SWARM_LIB}"
    grep -q '^try_become_leader()' "${SWARM_LIB}"
    grep -q '^start_leader_heartbeat()' "${SWARM_LIB}"
    grep -q '^wait_for_swarm_completion()' "${SWARM_LIB}"
}

teardown() {
    [[ -n "${TEST_ROOT:-}" ]] && rm -rf "${TEST_ROOT}"
}

@test "try_become_leader noclobber against our own file demotes AUTHORITY" {
    run bash -c '
        source "'"${SWARM_LIB}"'"
        export OE_ROOT="'"${TEST_ROOT}"'/openemr"
        mkdir -p "${OE_ROOT}/sites"
        date +%s > "${OE_ROOT}/sites/docker-leader"
        AUTHORITY=yes
        try_become_leader
        echo "AUTHORITY=${AUTHORITY}"
    '
    [[ $status -eq 0 ]]
    [[ $output == *"This instance is a follower (AUTHORITY=no)"* ]]
    [[ $output == *"AUTHORITY=no"* ]]
}

@test "wait_for_swarm_completion keeps AUTHORITY after in-loop takeover" {
    run bash -c '
        source "'"${SWARM_LIB}"'"
        export OE_ROOT="'"${TEST_ROOT}"'/openemr"
        mkdir -p "${OE_ROOT}/sites"
        date +%s > "${OE_ROOT}/sites/docker-leader"
        touch -d "10 minutes ago" "${OE_ROOT}/sites/docker-leader"
        AUTHORITY=no
        LEADER_WAIT_TIMEOUT=1
        wait_for_swarm_completion
        echo "AUTHORITY=${AUTHORITY}"
    '
    [[ $status -eq 0 ]]
    [[ $output == *"Successfully became leader after previous leader failure"* ]]
    [[ $output != *"Promoted to leader after waiting period"* ]]
    [[ $output == *"AUTHORITY=yes"* ]]
}

@test "start_leader_heartbeat refreshes the leader file and stop ends it" {
    run bash -c '
        source "'"${SWARM_LIB}"'"
        export OE_ROOT="'"${TEST_ROOT}"'/openemr"
        mkdir -p "${OE_ROOT}/sites"
        echo 0 > "${OE_ROOT}/sites/docker-leader"
        touch -d "10 minutes ago" "${OE_ROOT}/sites/docker-leader"
        AUTHORITY=yes
        SWARM_MODE=yes
        LEADER_HEARTBEAT_INTERVAL=1
        start_leader_heartbeat
        fresh=0
        for _ in 1 2 3 4 5 6; do
            now=$(date +%s)
            mtime=$(stat -c %Y "${OE_ROOT}/sites/docker-leader")
            if (( now - mtime < 3 )); then
                fresh=1
                break
            fi
            sleep 1
        done
        pid="${LEADER_HEARTBEAT_PID}"
        stop_leader_heartbeat
        if kill -0 "${pid}" 2>/dev/null; then
            echo "heartbeat still running after stop"
            exit 1
        fi
        touch -d "10 minutes ago" "${OE_ROOT}/sites/docker-leader"
        sleep 2
        now=$(date +%s)
        mtime=$(stat -c %Y "${OE_ROOT}/sites/docker-leader")
        echo "fresh=${fresh} age_after_stop=$((now - mtime))"
        (( fresh == 1 ))
        (( now - mtime > 60 ))
    '
    [[ $status -eq 0 ]]
    [[ $output == *"fresh=1"* ]]
}

@test "start_leader_heartbeat survives a failed write and retries" {
    run bash -c '
        source "'"${SWARM_LIB}"'"
        export OE_ROOT="'"${TEST_ROOT}"'/openemr"
        mkdir -p "${OE_ROOT}/sites/docker-leader"
        AUTHORITY=yes
        SWARM_MODE=yes
        LEADER_HEARTBEAT_INTERVAL=1
        start_leader_heartbeat
        pid="${LEADER_HEARTBEAT_PID}"
        sleep 2
        if ! kill -0 "${pid}" 2>/dev/null; then
            echo "heartbeat died after a failed write"
            exit 1
        fi
        rmdir "${OE_ROOT}/sites/docker-leader"
        fresh=0
        for _ in 1 2 3 4 5 6; do
            if [[ -f "${OE_ROOT}/sites/docker-leader" ]]; then
                now=$(date +%s)
                mtime=$(stat -c %Y "${OE_ROOT}/sites/docker-leader")
                if (( now - mtime < 3 )); then
                    fresh=1
                    break
                fi
            fi
            sleep 1
        done
        stop_leader_heartbeat
        echo "fresh=${fresh}"
        (( fresh == 1 ))
    '
    [[ $status -eq 0 ]]
    [[ $output == *"leader heartbeat write failed; retrying on the next tick"* ]]
    [[ $output == *"fresh=1"* ]]
}

@test "start_leader_heartbeat is a no-op when AUTHORITY=no" {
    run bash -c '
        source "'"${SWARM_LIB}"'"
        export OE_ROOT="'"${TEST_ROOT}"'/openemr"
        mkdir -p "${OE_ROOT}/sites"
        AUTHORITY=no
        SWARM_MODE=yes
        start_leader_heartbeat
        if [[ -n "${LEADER_HEARTBEAT_PID:-}" ]]; then
            echo "started a heartbeat as a follower"
            stop_leader_heartbeat
            exit 1
        fi
        echo "noop"
    '
    [[ $status -eq 0 ]]
    [[ $output == *"noop"* ]]
}
