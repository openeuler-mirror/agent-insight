#!/usr/bin/env bash
set -euo pipefail

# Unified benchmark pipeline that runs steps START_STEP..END_STEP.
#
# Steps:
#   1 — Run initial tasks
#   2 — Extract skills from tasks
#   3 — Import skills to the service
#   4 — Optimize skills (per mode)
#   5 — Create tasks from optimized skills (per mode)
#   6 — Execute tasks (per mode)
#
# Configuration is taken exclusively from skillbench/.env — there are no CLI
# args and no in-script defaults. Every variable below is required; the script
# fails (set -u) if any of them is missing.
#
# Required .env variables:
#   MODEL                — model passed to harbor (e.g. deepseek/deepseek-v3.2)
#   AGENT                — agent name (e.g. opencode)
#   START_STEP, END_STEP — step range to run, 1..6 (START_STEP <= END_STEP)
#   MODES                — space-separated optimization modes
#                          (any of: static dynamic hybrid feedback)
#   TASKS_INIT_DIR       — tasks_init directory used by steps 1, 2, 5
#   MAX_PARALLEL         — max parallel tasks for steps 1 and 6
#   RUNS                 — number of runs for steps 1 and 6
#
# BASE_DIR is autodetected from the script's location and exported before
# .env is sourced, so .env may interpolate ${BASE_DIR} (e.g. for TASKS_INIT_DIR).

die() {
    echo "Error: ${1}" >&2
    exit 1
}

# === Configuration ===
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SCRIPTS_DIR="${BASE_DIR}/scripts"
OPTIMIZER_SCRIPT="${BASE_DIR}/../skills/skill-optimizer/scripts/main_parallel.py"

TASKS_INIT_DIR="${BASE_DIR}/tasks_init"
RUNS_ROOT="${BASE_DIR}/runs"
RUNS_LATEST_LINK="${RUNS_ROOT}/latest"

source "${SCRIPTS_DIR}/lib/docker.sh"
source "${SCRIPTS_DIR}/lib/modes.sh"
source "${SCRIPTS_DIR}/check_api_keys.sh"

# Activate environment and load .env (BASE_DIR is exported so .env may
# interpolate it, e.g. TASKS_INIT_DIR=${BASE_DIR}/tasks_init).
export BASE_DIR
source "${BASE_DIR}/.venv/bin/activate"
set -a
source "${BASE_DIR}/.env"
set +a

IFS=' ' read -ra MODES_ARRAY <<< "$MODES"

require_api_key "${MODEL}"

RUN_DIR="${RUNS_ROOT}/$(date +%Y%m%d_%H%M%S)"
mkdir -p "${RUN_DIR}"
RUN_DIR="$(cd "${RUN_DIR}" && pwd)"

JOBS_INIT_DIR="${RUN_DIR}/jobs_init"
SKILLS_INIT_DIR="${RUN_DIR}/skills_init"

[[ "${START_STEP}" -ge 1 && "${START_STEP}" -le 6 ]] || die "Invalid START_STEP: ${START_STEP} (must be 1-6)"
[[ "${END_STEP}" -ge 1 && "${END_STEP}" -le 6 ]] || die "Invalid END_STEP: ${END_STEP} (must be 1-6)"
[[ "${START_STEP}" -le "${END_STEP}" ]] || die "START_STEP (${START_STEP}) cannot be greater than END_STEP (${END_STEP})"


# === Validation: every step in [START_STEP..END_STEP] ===
for (( _step=START_STEP; _step<=END_STEP; _step++ )); do
    case "${_step}" in
        1)
            : "${TASKS_INIT_DIR:?TASKS_INIT_DIR is not set in .env}"
            : "${MAX_PARALLEL:?MAX_PARALLEL is not set in .env}"
            : "${RUNS:?RUNS is not set in .env}"
            ;;
        2)
            : "${TASKS_INIT_DIR:?TASKS_INIT_DIR is not set in .env}"
            [[ -d "${TASKS_INIT_DIR}" ]] || die "Tasks init directory not found: ${TASKS_INIT_DIR}"
            ;;
        4)
            for mode in "${MODES_ARRAY[@]}"; do
                validate_mode "${mode}"
            done
            ;;
        6)
            : "${MAX_PARALLEL:?MAX_PARALLEL is not set in .env}"
            : "${RUNS:?RUNS is not set in .env}"
            ;;
    esac
done

# === Configuration output ===
echo "=========================================="
echo "Pipeline Configuration"
echo "=========================================="
echo "🤖 Model: ${MODEL}"
echo "🧑 Agent: ${AGENT}"
echo "📊 Max parallel tasks: ${MAX_PARALLEL}"
echo "🔄 Runs per task step: ${RUNS}"
echo "📐 Steps: ${START_STEP} → ${END_STEP}"
echo "📁 Tasks init directory: ${TASKS_INIT_DIR}"
echo "📁 Run directory: ${RUN_DIR}"
echo "📁 Jobs init directory: ${JOBS_INIT_DIR}"
echo "🔀 Modes: ${MODES_ARRAY[*]}"
echo "=========================================="

# === Common helper: run tasks step ===
run_tasks_step() {
    local tasks_dir="${1}"
    local jobs_dir="${2}"
    local label="${3}"
    local runs="${4}"
    local log_dir="${5}"
    local failed_runs=0

    local run run_log
    for (( run=1; run<=runs; run++ )); do
        run_log="${log_dir}/${label}_run${run}.log"
        echo "  --- ${label} run ${run}/${runs} ---"
        LOG_DIR="${log_dir}/${label}_run${run}" \
        "${SCRIPTS_DIR}/run_tasks_parallel_final.sh" \
            "${tasks_dir}" "${jobs_dir}" "${MODEL}" "${MAX_PARALLEL}" "${AGENT}" \
            >> "${run_log}" 2>&1 \
            || { failed_runs=$((failed_runs + 1)); true; }
    done

    return "${failed_runs}"
}

log_dir="${RUN_DIR}/logs"
mkdir -p "${log_dir}"
echo "Logs: ${log_dir}"
echo ""

# ============================================================================
# STEP 1: Run initial tasks
# ============================================================================
if [[ "${START_STEP}" -le 1 && "${END_STEP}" -ge 1 ]]; then
    echo "=========================================="
    echo "Step 1/6: Running initial tasks (${RUNS} run(s))"
    echo "=========================================="
    mkdir -p "${JOBS_INIT_DIR}"
    init_failed_runs=0
    run_tasks_step "${TASKS_INIT_DIR}" "${JOBS_INIT_DIR}" "init" "${RUNS}" "${log_dir}" \
        || init_failed_runs=$?
    echo "[init] Pipeline completed: ${RUNS} run(s), ${init_failed_runs} with errors"
    echo ""

    # Step 1 has produced data — point runs/latest at this run dir.
    mkdir -p "${RUNS_ROOT}"
    ln -sfn "${RUN_DIR}" "${RUNS_LATEST_LINK}"

    docker_cleanup
fi

# ============================================================================
# STEP 2: Extract skills
# ============================================================================
if [[ "${START_STEP}" -le 2 && "${END_STEP}" -ge 2 ]]; then
    echo "=========================================="
    echo "Step 2/6: Extracting skills from tasks"
    echo "=========================================="
    python3 "${SCRIPTS_DIR}/extract_skills_info.py" \
        "${TASKS_INIT_DIR}" "${SKILLS_INIT_DIR}"
    echo ""
fi

# ============================================================================
# STEP 3: Import skills
# ============================================================================
if [[ "${START_STEP}" -le 3 && "${END_STEP}" -ge 3 ]]; then
    echo "=========================================="
    echo "Step 3/6: Importing skills to the service"
    echo "=========================================="
    "${SCRIPTS_DIR}/import_skills.sh" "${SKILLS_INIT_DIR}" "${log_dir}"
    echo ""
fi

# ============================================================================
# STEPS 4-5-6: Optimization → Task creation → Execution (per mode)
# ============================================================================
if [[ "${END_STEP}" -ge 4 ]]; then
    echo "=========================================="
    echo "Steps 4-6: Optimization + task creation + execution"
    echo "Modes (sequential): ${MODES_ARRAY[*]}"
    echo "=========================================="

    failed=0
    for mode in "${MODES_ARRAY[@]}"; do
        mode_log="${log_dir}/${mode}.log"

        optimized_dir="${RUN_DIR}/skills_optimized-${mode}"
        tasks_mode_dir="${RUN_DIR}/tasks_${mode}"
        jobs_mode_dir="${RUN_DIR}/jobs_${mode}"

        echo ""
        echo "------------------------------------------"
        echo "[${mode}] Starting mode pipeline"
        echo "------------------------------------------"

        # --- Step 4: Optimization ---
        PYTHON_BIN=$(which python3)

        if [[ "${START_STEP}" -le 4 && "${END_STEP}" -ge 4 ]]; then
            echo "[${mode}] Step 4: Optimizing skills..."
            if ! env -i "${PYTHON_BIN}" "${OPTIMIZER_SCRIPT}" \
                    --mode "${mode}" \
                    --input "${SKILLS_INIT_DIR}" \
                    --output "${optimized_dir}" \
                    --no-open-diff >> "${mode_log}" 2>&1; then
                echo "[${mode}] Optimization failed (log: ${mode_log})"
                failed=$((failed + 1))
                continue
            fi
            echo "[${mode}] Step 4: OK"
        fi

        # --- Step 5: Task creation ---
        if [[ "${START_STEP}" -le 5 && "${END_STEP}" -ge 5 ]]; then
            echo "[${mode}] Step 5: Creating tasks from ${optimized_dir}..."
            if ! python3 "${SCRIPTS_DIR}/create_tasks_mode.py" \
                    "${TASKS_INIT_DIR}" "${optimized_dir}" \
                    --dest-dir "${tasks_mode_dir}" >> "${mode_log}" 2>&1; then
                echo "[${mode}] Task creation failed (log: ${mode_log})"
                failed=$((failed + 1))
                continue
            fi
            echo "[${mode}] Step 5: OK"
        fi

        # --- Docker cleanup before running tasks ---
        if [[ "${START_STEP}" -le 6 && "${END_STEP}" -ge 6 ]]; then
            echo "[${mode}] Docker cleanup before running tasks..."
            docker_cleanup >> "${mode_log}" 2>&1

            # --- Step 6: Task execution ---
            mkdir -p "${jobs_mode_dir}"
            mode_failed_runs=0
            run_tasks_step "${tasks_mode_dir}" "${jobs_mode_dir}" "${mode}" "${RUNS}" "${log_dir}" \
                || mode_failed_runs=$?
            echo "[${mode}] Pipeline completed: ${RUNS} run(s), ${mode_failed_runs} with errors"
        fi
    done
fi

# === Summary ===
echo ""
echo "=========================================="
echo "Pipeline completed (steps ${START_STEP}→${END_STEP})"
echo "Modes: ${#MODES_ARRAY[*]}"
echo "Run dir: ${RUN_DIR}"
echo "Latest:  ${RUNS_LATEST_LINK} -> ${RUN_DIR}"
echo "Logs:    ${log_dir}"
echo "=========================================="
