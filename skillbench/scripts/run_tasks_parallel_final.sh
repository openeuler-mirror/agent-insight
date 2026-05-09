#!/usr/bin/env bash
set -euo pipefail

# Parallel execution of tasks from the specified directory.
# AGENT defaults to "opencode"; pass a different one as the 5th positional arg.
#
# LOG_DIR (env var, optional) — where to write per-task harbor stdout/stderr.
# When invoked from run_pipeline.sh it points inside the run dir so logs from
# concurrent / consecutive pipeline runs don't overwrite each other. Standalone
# callers may leave it unset — logs then go to skillbench/logs/.
#
# Usage: ./run_tasks_parallel_final.sh <TASK_DIR> <JOBS_DIR> <MODEL> [MAX_PARALLEL] [AGENT]

die() {
  echo "Error: ${1}" >&2
  exit 1
}

# === Arguments ===
[[ $# -ge 3 ]] || die "Usage: ${0} <TASK_DIR> <JOBS_DIR> <MODEL> [MAX_PARALLEL] [AGENT]"

TASKS_DIR="${1}"
JOBS_DIR="${2}"
MODEL="${3}"
MAX_PARALLEL="${4:-3}"
AGENT="${5:-opencode}"

[[ -d "${TASKS_DIR}" ]] || die "Tasks directory not found: ${TASKS_DIR}"

# === Extract mode from TASK_DIR name ===
# tasks_init → init, tasks_static → static, tasks_dynamic → dynamic, etc.
tasks_basename="$(basename "${TASKS_DIR}")"

extract_mode() {
  local name="${1}"
  # Expected format: tasks_<mode> or tasks-<mode>
  if [[ "${name}" =~ ^tasks[_-](.+)$ ]]; then
    echo "${BASH_REMATCH[1]}"
  else
    echo "${name}"
  fi
}

MODE="$(extract_mode "${tasks_basename}")"

# === Check dependencies ===
command -v uv >/dev/null 2>&1 || die "uv not found. Install uv or specify the full path."

# Load .env from skillbench root (two levels up from this script)
SKILLBENCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
echo "SKILLBENCH_DIR ${SKILLBENCH_DIR}"
# Load .env, but keep CLI MODEL/AGENT authoritative (they come from positional args).
if [[ -f "${SKILLBENCH_DIR}/.env" ]]; then
  cli_model="${MODEL}"
  cli_agent="${AGENT}"
  set -a
  # shellcheck source=/dev/null
  source "${SKILLBENCH_DIR}/.env"
  set +a
  MODEL="${cli_model}"
  AGENT="${cli_agent}"
fi

# Check API keys for the specified model (.env already sourced above).
source "${SKILLBENCH_DIR}/scripts/check_api_keys.sh"
require_api_key "${MODEL}"

echo "=========================================="
echo "Parallel task execution"
echo "  TASK_DIR:     ${TASKS_DIR}"
echo "  JOBS_DIR:     ${JOBS_DIR}"
echo "  MODE:         ${MODE}"
echo "  MODEL:        ${MODEL}"
echo "  AGENT:        ${AGENT}"
echo "  MAX_PARALLEL: ${MAX_PARALLEL}"
echo "  Total tasks:  $(find "${TASKS_DIR}" -mindepth 1 -maxdepth 1 -type d | wc -l)"
echo "=========================================="

declare -a PIDS
declare -a TASK_NAMES

LOGS_DIR="${LOG_DIR:-${SKILLBENCH_DIR}/logs}"
mkdir -p "${LOGS_DIR}"

CURRENT_PARALLEL=0
TASK_INDEX=0
SUCCESS_COUNT=0
FAILED_COUNT=0

for task_dir in "${TASKS_DIR}"/*/; do
  if [[ -d "${task_dir}" ]]; then
    task_name="$(basename "${task_dir}")"
    TASK_INDEX=$((TASK_INDEX + 1))

    # Wait when the parallel task limit is reached (0 = unlimited)
    while (( MAX_PARALLEL > 0 && CURRENT_PARALLEL >= MAX_PARALLEL )); do
      for i in "${!PIDS[@]}"; do
        if ! kill -0 "${PIDS[$i]}" 2>/dev/null; then
          wait "${PIDS[$i]}" || true
          exit_code=$?
          if [[ ${exit_code} -eq 0 ]]; then
            echo "OK Task ${TASK_NAMES[$i]} completed successfully"
            SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
          else
            echo "FAIL Task ${TASK_NAMES[$i]} finished with an error (code: ${exit_code})"
            FAILED_COUNT=$((FAILED_COUNT + 1))
          fi
          unset "PIDS[$i]"
          unset "TASK_NAMES[$i]"
          CURRENT_PARALLEL=$((CURRENT_PARALLEL - 1))
        fi
      done
      # Re-index arrays
      PIDS=("${PIDS[@]}")
      TASK_NAMES=("${TASK_NAMES[@]}")
      sleep 2
    done

    echo ""
    echo "=========================================="
    echo "Running task ${TASK_INDEX}: ${task_name}"
    echo "Current parallel: ${CURRENT_PARALLEL}"

    # Launch task in background. --job-name carries a random suffix so two
    # harbor runs starting in the same wall-clock second can't share the
    # default timestamp-named directory.
    uv run harbor run \
      -p "${task_dir}" \
      -a "${AGENT}" \
      -m "${MODEL}" \
      --jobs-dir "${JOBS_DIR}" \
      --job-name "${task_name}_${RANDOM}${RANDOM}" \
      > "${LOGS_DIR}/${task_name}.log" 2>&1 &
    pid=$!
    echo "PID: ${pid}"

    PIDS+=("${pid}")
    TASK_NAMES+=("${task_name}")
    CURRENT_PARALLEL=$((CURRENT_PARALLEL + 1))

    sleep 2
  fi
done

echo ""
echo "=========================================="
echo "All tasks launched. Waiting for completion..."
echo "=========================================="

for i in "${!PIDS[@]}"; do
  wait "${PIDS[$i]}" || true
  exit_code=$?
  if [[ ${exit_code} -eq 0 ]]; then
    echo "OK Task ${TASK_NAMES[$i]} completed successfully"
    SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
  else
    echo "FAIL Task ${TASK_NAMES[$i]} finished with an error (code: ${exit_code})"
    FAILED_COUNT=$((FAILED_COUNT + 1))
  fi
done

TOTAL_COUNT=$((SUCCESS_COUNT + FAILED_COUNT))

echo ""
echo "=========================================="
echo "Execution summary:"
echo "  Total tasks: ${TOTAL_COUNT}"
echo "  Successful:  ${SUCCESS_COUNT}"
echo "  Failed:      ${FAILED_COUNT}"
echo "=========================================="

if [[ ${FAILED_COUNT} -eq 0 ]]; then
  echo "All tasks completed successfully!"
  exit 0
else
  echo "Some tasks finished with errors"
  exit 1
fi
