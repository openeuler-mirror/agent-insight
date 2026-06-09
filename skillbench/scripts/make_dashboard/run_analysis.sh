#!/bin/bash
# Run the current file-based SkillBench analysis suite.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
SKILLBENCH_DIR="${REPO_ROOT}/skillbench"

# Allow override via env or first positional arg, otherwise default to runs/latest
# (the canonical home of pipeline outputs). Fall back to the skillbench root for
# legacy layouts where jobs_* still live there directly.
SKILLBENCH_ROOT="${SKILLBENCH_ROOT:-${1:-}}"
if [[ -z "${SKILLBENCH_ROOT}" ]]; then
    if [[ -L "${SKILLBENCH_DIR}/runs/latest" || -d "${SKILLBENCH_DIR}/runs/latest" ]]; then
        SKILLBENCH_ROOT="$(readlink -f "${SKILLBENCH_DIR}/runs/latest")"
    else
        SKILLBENCH_ROOT="${SKILLBENCH_DIR}"
    fi
fi

OUTPUT_DIR="${SKILLBENCH_ROOT}/plots"
PAIRWISE_DIR="${OUTPUT_DIR}/pairwise"

mkdir -p "${OUTPUT_DIR}" "${PAIRWISE_DIR}"
cd "${SKILLBENCH_DIR}"

echo "Analyzing run: ${SKILLBENCH_ROOT}"

echo "Generating strict 4-way summary..."
uv run python3 scripts/make_dashboard/summarize_job_groups.py \
    --skillbench-root "${SKILLBENCH_ROOT}" \
    --format md \
    --show-task-table \
    --output "${OUTPUT_DIR}/job_group_summary.md"

echo "Generating pairwise init-vs-mode comparisons..."
uv run python3 scripts/make_dashboard/compare_init_vs_mode.py \
    --skillbench-root "${SKILLBENCH_ROOT}" \
    --output-dir "${PAIRWISE_DIR}"

echo "Generating per-task tables..."
uv run python3 scripts/make_dashboard/task_mode_tables.py \
    --skillbench-root "${SKILLBENCH_ROOT}" \
    --output-dir "${OUTPUT_DIR}/tables"

echo "Analysis outputs:"
echo "  - ${OUTPUT_DIR}/job_group_summary.md"
echo "  - ${PAIRWISE_DIR}/summary.md"
echo "  - ${OUTPUT_DIR}/tables/index.html"
