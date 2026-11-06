# BATS: binary openemr.sh upgrade gate — a new image on an old sites/ volume (#153)

load '../test_helper/bats-support/load'
load '../test_helper/bats-assert/load'
load '../helpers'

setup() {
    upgrade_gate_setup binary
    (( IMAGE_VERSION > 3 ))
    SITES_MARKER="${FAKE_OE_ROOT}/sites/default/docker-version"
}

@test "binary upgrade gate: the image ships its docker-version as the webroot code marker" {
    assert_file_exists "${FAKE_OE_ROOT}/docker-version"
    assert_equal "$(cat "${FAKE_OE_ROOT}/docker-version")" "$IMAGE_VERSION"
}

@test "binary upgrade gate: image swap on an older sites/ volume runs each fsupgrade above it, in order" {
    local old=$(( IMAGE_VERSION - 3 ))
    printf '%s' "$old" > "$SITES_MARKER"
    run_upgrade_gate 1
    assert_success
    assert_output --partial "Upgrade detected: ${old} -> ${IMAGE_VERSION}"
    assert_output --partial "GATE_PASSED"
    assert_equal "$(cat "$UPGRADE_RAN")" "$(seq $(( old + 1 )) "$IMAGE_VERSION")"
    assert_equal "$(cat "$SITES_MARKER")" "$IMAGE_VERSION"
}

@test "binary upgrade gate: the boot after an upgrade runs nothing" {
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

@test "binary upgrade gate: a whole webroot kept on an old volume is not upgraded" {
    printf '%s' "$(( IMAGE_VERSION - 1 ))" > "${FAKE_OE_ROOT}/docker-version"
    printf '%s' "$(( IMAGE_VERSION - 1 ))" > "$SITES_MARKER"
    run_upgrade_gate 1
    assert_success
    assert_output "GATE_PASSED"
    assert_equal "$(cat "$UPGRADE_RAN")" ""
    assert_equal "$(cat "$SITES_MARKER")" "$(( IMAGE_VERSION - 1 ))"
}

@test "binary upgrade gate: a site set up through the web installer gets a marker and replays nothing" {
    # Only auto-configure writes the sites marker; MANUAL_SETUP sites have none.
    run_upgrade_gate 1
    assert_success
    assert_output --partial "GATE_PASSED"
    refute_output --partial "Upgrade detected"
    assert_equal "$(cat "$UPGRADE_RAN")" ""
    assert_equal "$(cat "$SITES_MARKER")" "$IMAGE_VERSION"
}

@test "binary upgrade gate: a sites marker of 0 runs every fsupgrade without tripping set -e" {
    printf '0' > "$SITES_MARKER"
    run_upgrade_gate 1
    assert_success
    assert_output --partial "GATE_PASSED"
    assert_equal "$(cat "$UPGRADE_RAN")" "$(seq 1 "$IMAGE_VERSION")"
    assert_equal "$(cat "$SITES_MARKER")" "$IMAGE_VERSION"
}

@test "binary upgrade gate: a never-configured site boots on to first-time setup" {
    run_upgrade_gate 0
    assert_success
    assert_output "GATE_PASSED"
    assert_equal "$(cat "$UPGRADE_RAN")" ""
}
