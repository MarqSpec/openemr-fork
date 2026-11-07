# BATS: release openemr.sh cleanup_setup_scripts — what RUN_DB_UPGRADE keeps (#197)

load '../test_helper/bats-support/load'
load '../test_helper/bats-assert/load'
load '../helpers'

setup() {
    local script
    FAKE_OE_ROOT="${BATS_TEST_TMPDIR}/openemr"
    AUTO_CONFIG="${BATS_TEST_TMPDIR}/auto_configure.php"
    CLEANUP_LIB="${BATS_TEST_TMPDIR}/cleanup.bash"
    mkdir -p "$FAKE_OE_ROOT"
    touch "$AUTO_CONFIG"
    for script in admin setup auto_configure sql_patch sql_upgrade ippf_upgrade acl_upgrade; do
        touch "${FAKE_OE_ROOT}/${script}.php"
    done
    extract_bash_function "$(get_script_dir release)/openemr.sh" cleanup_setup_scripts > "$CLEANUP_LIB"
}

# Usage: run_cleanup <RUN_DB_UPGRADE value>
run_cleanup() {
    # shellcheck disable=SC2016  # expanded by the inner bash, not here
    run bash -c '
        set -euo pipefail
        OE_ROOT="$1"
        AUTO_CONFIG="$2"
        RUN_DB_UPGRADE="$3"
        is_configured() { echo 1; }
        source "$4"
        cleanup_setup_scripts
    ' _ "$FAKE_OE_ROOT" "$AUTO_CONFIG" "$1" "$CLEANUP_LIB"
}

@test "cleanup: without RUN_DB_UPGRADE every setup and upgrade script goes" {
    run_cleanup no
    assert_success
    run find "$FAKE_OE_ROOT" -type f
    assert_output ""
}

@test "cleanup: RUN_DB_UPGRADE=yes keeps the upgrade scripts and removes the installers" {
    run_cleanup yes
    assert_success
    assert_file_exists "${FAKE_OE_ROOT}/sql_patch.php"
    assert_file_exists "${FAKE_OE_ROOT}/sql_upgrade.php"
    assert_file_exists "${FAKE_OE_ROOT}/ippf_upgrade.php"
    assert_file_exists "${FAKE_OE_ROOT}/acl_upgrade.php"
    [[ ! -e "${FAKE_OE_ROOT}/admin.php" ]]
    [[ ! -e "${FAKE_OE_ROOT}/setup.php" ]]
    [[ ! -e "${FAKE_OE_ROOT}/auto_configure.php" ]]
}

@test "cleanup: RUN_DB_UPGRADE=yes keeps every webroot script sql_upgrade.php requires" {
    local required script
    run_cleanup yes
    assert_success
    required="$(grep -oE "require(_once)?\([\"'][a-z_]+\.php[\"']\)" "$(get_repo_root)/sql_upgrade.php" | sed -E "s/.*[\"'](.*)[\"'].*/\1/")"
    [[ -n "$required" ]]
    for script in $required; do
        assert_file_exists "${FAKE_OE_ROOT}/${script}"
    done
}
