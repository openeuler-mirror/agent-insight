# SKILLBENCH_MODES — canonical list of optimization modes
SKILLBENCH_MODES=("static" "dynamic" "hybrid" "feedback")

# validate_mode <mode> — exits with error if mode is not recognized
validate_mode() {
    local mode="${1:?validate_mode requires mode}"
    case "${mode}" in
        static|dynamic|hybrid|feedback) ;;
        *) echo "Error: Invalid mode '${mode}'. Expected: static, dynamic, hybrid, feedback" >&2; exit 1 ;;
    esac
}
