# BATS: release openemr.sh upgrade gate — a new image on an old sites/ volume (#153)

load '../test_helper/bats-support/load'
load '../test_helper/bats-assert/load'
load '../helpers'

setup() {
    upgrade_gate_setup release
    (( IMAGE_VERSION > 3 ))
    SITES_MARKER="${FAKE_OE_ROOT}/sites/default/docker-version"
    COMPLETED="${FAKE_OE_ROOT}/sites/docker-completed"
    LEADER="${FAKE_OE_ROOT}/sites/docker-leader"
    swarm_boot_setup
}

@test "upgrade gate: the image ships its docker-version as the webroot code marker" {
    assert_file_exists "${FAKE_OE_ROOT}/docker-version"
    assert_equal "$(cat "${FAKE_OE_ROOT}/docker-version")" "$IMAGE_VERSION"
}

@test "upgrade gate: image swap on an older sites/ volume runs each fsupgrade above it, in order" {
    local old=$(( IMAGE_VERSION - 3 ))
    printf '%s' "$old" > "$SITES_MARKER"
    run_upgrade_gate 1
    assert_success
    assert_output --partial "Upgrade detected: ${old} -> ${IMAGE_VERSION}"
    assert_output --partial "GATE_PASSED"
    assert_equal "$(cat "$UPGRADE_RAN")" "$(seq $(( old + 1 )) "$IMAGE_VERSION")"
    assert_equal "$(cat "$SITES_MARKER")" "$IMAGE_VERSION"
}

@test "upgrade gate: the boot after an upgrade runs nothing" {
    printf '%s' "$(( IMAGE_VERSION - 1 ))" > "$SITES_MARKER"
    run_upgrade_gate 1
    assert_success
    assert_equal "$(cat "$UPGRADE_RAN")" "$IMAGE_VERSION"
    : > "$UPGRADE_RAN"
    run_upgrade_gate 1
    assert_success
    assert_output "GATE_PASSED"
    assert_equal "$(cat "$UPGRADE_RAN")" ""
}

@test "upgrade gate: a whole webroot kept on an old volume is not upgraded" {
    printf '%s' "$(( IMAGE_VERSION - 1 ))" > "${FAKE_OE_ROOT}/docker-version"
    printf '%s' "$(( IMAGE_VERSION - 1 ))" > "$SITES_MARKER"
    run_upgrade_gate 1
    assert_success
    assert_output "GATE_PASSED"
    assert_equal "$(cat "$UPGRADE_RAN")" ""
    assert_equal "$(cat "$SITES_MARKER")" "$(( IMAGE_VERSION - 1 ))"
}

@test "upgrade gate: a site set up through the web installer gets a marker and replays nothing" {
    # Only auto-configure writes the sites marker; MANUAL_SETUP sites have none.
    run_upgrade_gate 1
    assert_success
    assert_output --partial "GATE_PASSED"
    refute_output --partial "Upgrade detected"
    assert_equal "$(cat "$UPGRADE_RAN")" ""
    assert_equal "$(cat "$SITES_MARKER")" "$IMAGE_VERSION"
}

@test "upgrade gate: a sites marker of 0 runs every fsupgrade without tripping set -e" {
    printf '0' > "$SITES_MARKER"
    run_upgrade_gate 1
    assert_success
    assert_output --partial "GATE_PASSED"
    assert_equal "$(cat "$UPGRADE_RAN")" "$(seq 1 "$IMAGE_VERSION")"
    assert_equal "$(cat "$SITES_MARKER")" "$IMAGE_VERSION"
}

@test "upgrade gate: a never-configured site boots on to first-time setup" {
    run_upgrade_gate 0
    assert_success
    assert_output "GATE_PASSED"
    assert_equal "$(cat "$UPGRADE_RAN")" ""
}

@test "swarm: a new image on a completed volume upgrades, then releases the lock" {
    printf '%s' "$(( IMAGE_VERSION - 2 ))" > "$SITES_MARKER"
    touch "$COMPLETED"
    run bash "$SWARM_BOOT"
    assert_success
    assert_output --partial "This instance is the docker-leader (AUTHORITY=yes)"
    assert_output --partial "Upgrade detected: $(( IMAGE_VERSION - 2 )) -> ${IMAGE_VERSION}"
    assert_output --partial "BOOTED AUTHORITY=yes HEARTBEAT=none"
    assert_equal "$(cat "$UPGRADE_RAN")" "$(seq $(( IMAGE_VERSION - 1 )) "$IMAGE_VERSION")"
    assert_equal "$(cat "$SITES_MARKER")" "$IMAGE_VERSION"
    [[ ! -e "$LEADER" ]]
}

@test "swarm: no newer version stays a follower and takes no lock" {
    printf '%s' "$IMAGE_VERSION" > "$SITES_MARKER"
    touch "$COMPLETED"
    run bash "$SWARM_BOOT"
    assert_success
    assert_output --partial "Setup already complete, this instance is a follower (AUTHORITY=no)"
    assert_output --partial "BOOTED AUTHORITY=no"
    refute_output --partial "Waiting for docker-leader"
    assert_equal "$(cat "$UPGRADE_RAN")" ""
    [[ ! -e "$LEADER" ]]
}

@test "swarm: a volume ahead of the image stays a follower" {
    printf '%s' "$(( IMAGE_VERSION + 1 ))" > "$SITES_MARKER"
    touch "$COMPLETED"
    run bash "$SWARM_BOOT"
    assert_success
    assert_output --partial "BOOTED AUTHORITY=no"
    assert_equal "$(cat "$UPGRADE_RAN")" ""
    assert_equal "$(cat "$SITES_MARKER")" "$(( IMAGE_VERSION + 1 ))"
}

@test "swarm: a whole webroot kept on an old volume stays a follower" {
    printf '%s' "$(( IMAGE_VERSION - 1 ))" > "${FAKE_OE_ROOT}/docker-version"
    printf '%s' "$(( IMAGE_VERSION - 1 ))" > "$SITES_MARKER"
    touch "$COMPLETED"
    run bash "$SWARM_BOOT"
    assert_success
    assert_output --partial "BOOTED AUTHORITY=no"
    assert_equal "$(cat "$UPGRADE_RAN")" ""
}

@test "swarm: a completed site with no sites marker stays a follower" {
    touch "$COMPLETED"
    run bash "$SWARM_BOOT"
    assert_success
    assert_output --partial "BOOTED AUTHORITY=no"
    assert_equal "$(cat "$UPGRADE_RAN")" ""
    [[ ! -e "$SITES_MARKER" ]]
}

@test "swarm: first-time setup still elects a leader, and no leader file is not a takeover" {
    run bash "$SWARM_BOOT"
    assert_success
    assert_output --partial "This instance is the docker-leader (AUTHORITY=yes)"
    refute_output --partial "appears stale"
    assert_file_exists "$COMPLETED"
}

@test "swarm: replicas starting together run each fsupgrade exactly once" {
    local round statuses
    touch "$COMPLETED"
    printf 'sleep 0.5\n' >> "${FAKE_ROOT}/fsupgrade-${IMAGE_VERSION}.sh"
    for round in 1 2 3; do
        printf '%s' "$(( IMAGE_VERSION - 2 ))" > "$SITES_MARKER"
        : > "$UPGRADE_RAN"
        statuses="$(run_replicas 8 | sort -u)"
        assert_equal "$statuses" "0"
        assert_equal "$(cat "$UPGRADE_RAN")" "$(seq $(( IMAGE_VERSION - 1 )) "$IMAGE_VERSION")"
        assert_equal "$(grep -l 'BOOTED AUTHORITY=yes' "$REPLICA_LOGS"/*.log | wc -l)" "1"
        assert_equal "$(grep -l 'BOOTED AUTHORITY=no' "$REPLICA_LOGS"/*.log | wc -l)" "7"
        assert_equal "$(cat "$SITES_MARKER")" "$IMAGE_VERSION"
    done
}

@test "swarm: a follower waits for a live upgrade, then starts without running it" {
    printf '%s' "$(( IMAGE_VERSION - 1 ))" > "$SITES_MARKER"
    touch "$COMPLETED"
    date +%s > "$LEADER"
    ( command sleep 0.5; printf '%s' "$IMAGE_VERSION" > "$SITES_MARKER" ) &
    run bash "$SWARM_BOOT"
    wait
    assert_success
    assert_output --partial "Waiting for docker-leader"
    assert_output --partial "BOOTED AUTHORITY=no"
    assert_equal "$(cat "$UPGRADE_RAN")" ""
}

@test "swarm: a live upgrade that outlasts the wait stops the follower" {
    printf '%s' "$(( IMAGE_VERSION - 1 ))" > "$SITES_MARKER"
    touch "$COMPLETED"
    date +%s > "$LEADER"
    LEADER_WAIT_TIMEOUT=20 run bash "$SWARM_BOOT"
    assert_failure 1
    assert_output --partial "the upgrade to this image did not finish within 20s"
    refute_output --partial "BOOTED"
    assert_equal "$(cat "$UPGRADE_RAN")" ""
}

@test "swarm: a crashed upgrade keeps the old marker, and the stale lock goes to one replica" {
    local statuses
    printf '%s' "$(( IMAGE_VERSION - 1 ))" > "$SITES_MARKER"
    touch "$COMPLETED"
    cp "${FAKE_ROOT}/fsupgrade-${IMAGE_VERSION}.sh" "${BATS_TEST_TMPDIR}/good.sh"
    printf 'exit 7\n' > "${FAKE_ROOT}/fsupgrade-${IMAGE_VERSION}.sh"
    run bash "$SWARM_BOOT"
    assert_failure 7
    assert_equal "$(cat "$SITES_MARKER")" "$(( IMAGE_VERSION - 1 ))"
    assert_file_exists "$LEADER"

    cp "${BATS_TEST_TMPDIR}/good.sh" "${FAKE_ROOT}/fsupgrade-${IMAGE_VERSION}.sh"
    printf 'sleep 0.5\n' >> "${FAKE_ROOT}/fsupgrade-${IMAGE_VERSION}.sh"
    touch -t 200001010000 "$LEADER"
    statuses="$(run_replicas 2 | sort -u)"
    assert_equal "$statuses" "0"
    assert_equal "$(cat "$UPGRADE_RAN")" "$IMAGE_VERSION"
    assert_equal "$(cat "$SITES_MARKER")" "$IMAGE_VERSION"
    [[ ! -e "$LEADER" ]]
}

@test "swarm: a follower that finds the leader dead while waiting takes the upgrade over" {
    local statuses
    printf '%s' "$(( IMAGE_VERSION - 1 ))" > "$SITES_MARKER"
    touch "$COMPLETED"
    date +%s > "$LEADER"
    printf 'sleep 0.5\n' >> "${FAKE_ROOT}/fsupgrade-${IMAGE_VERSION}.sh"
    ( command sleep 0.3; touch -t 200001010000 "$LEADER" ) &
    statuses="$(run_replicas 3 | sort -u)"
    wait
    assert_equal "$statuses" "0"
    assert_equal "$(grep -l 'Successfully became leader' "$REPLICA_LOGS"/*.log | wc -l)" "1"
    assert_equal "$(grep -l 'BOOTED AUTHORITY=yes' "$REPLICA_LOGS"/*.log | wc -l)" "1"
    assert_equal "$(cat "$UPGRADE_RAN")" "$IMAGE_VERSION"
}

@test "swarm: the heartbeat keeps an fsupgrade longer than LEADER_TIMEOUT from a takeover" {
    local statuses
    printf '%s' "$(( IMAGE_VERSION - 1 ))" > "$SITES_MARKER"
    touch "$COMPLETED"
    printf 'sleep 4\n' >> "${FAKE_ROOT}/fsupgrade-${IMAGE_VERSION}.sh"
    export LEADER_TIMEOUT=1 LEADER_WAIT_TIMEOUT=100000
    statuses="$(run_replicas 2 | sort -u)"
    unset LEADER_TIMEOUT LEADER_WAIT_TIMEOUT
    assert_equal "$statuses" "0"
    assert_equal "$(cat "$UPGRADE_RAN")" "$IMAGE_VERSION"
}
