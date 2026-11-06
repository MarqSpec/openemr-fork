# BATS: binary upgrade scripts (1–11)

load '../helpers'

setup() {
    SCRIPT_DIR="$(get_script_dir binary)"
    [[ -n "$SCRIPT_DIR" ]] && [[ -d "$SCRIPT_DIR" ]]
    UPGRADE_DIR="${SCRIPT_DIR}/upgrade"
}

@test "binary upgrade: docker-version is 11" {
    assert_file_exists "${UPGRADE_DIR}/docker-version"
    run cat "${UPGRADE_DIR}/docker-version"
    [[ $output == "11" ]]
}

@test "binary upgrade: fsupgrade-1 through 11 exist" {
    for i in 1 2 3 4 5 6 7 8 9 10 11; do
        assert_file_exists "${UPGRADE_DIR}/fsupgrade-${i}.sh"
    done
}

@test "binary upgrade: each iterates sites" {
    for i in 1 2 3 4 5 6 7 8 9 10 11; do
        assert_script_contains "${UPGRADE_DIR}/fsupgrade-${i}.sh" 'sites/\*/'
    done
}

@test "binary upgrade: no fsupgrade-12" {
    [[ ! -f "${UPGRADE_DIR}/fsupgrade-12.sh" ]]
}

@test "binary upgrade: Dockerfile copies and enables every fsupgrade" {
    for i in 1 2 3 4 5 6 7 8 9 10 11; do
        assert_script_contains "${SCRIPT_DIR}/Dockerfile" "upgrade/fsupgrade-${i}\.sh"
        assert_script_contains "${SCRIPT_DIR}/Dockerfile" "/root/fsupgrade-${i}\.sh"
    done
}

@test "binary upgrade: scripts 9-11 match the release image's" {
    for i in 9 10 11; do
        cmp "${UPGRADE_DIR}/fsupgrade-${i}.sh" "$(get_script_dir release)/upgrade/fsupgrade-${i}.sh"
    done
}
