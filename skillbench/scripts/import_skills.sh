#!/usr/bin/env bash
set -euo pipefail

# Import all skill folders from the specified directory via API.
#
# Usage: ./import_skills.sh <SKILLS_DIR> [LOG_DIR]
# When called from run_pipeline.sh, LOG_DIR is the run's logs/ directory so that
# every pipeline log lives under the same run dir. Standalone callers may omit
# it — the log then goes to skillbench/logs/.

die() {
    echo "Error: ${1}" >&2
    exit 1
}

[[ $# -ge 1 && $# -le 2 ]] || die "Usage: ${0} <SKILLS_DIR> [LOG_DIR]"

SKILLS_DIR="${1}"

[[ -d "${SKILLS_DIR}" ]] || die "Directory not found: ${SKILLS_DIR}"

# Load .env from skillbench root (two levels up from this script)
SKILLBENCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "${SKILLBENCH_DIR}/.env" ]]; then
    set -a
    # shellcheck source=/dev/null
    source "${SKILLBENCH_DIR}/.env"
    set +a
fi

LOG_DIR="${2:-${SKILLBENCH_DIR}/logs}"
BASE_URL="${SKILL_INSIGHT_BASE_URL:-http://localhost:3000}"

# Log file
LOG_FILE="${LOG_DIR}/import_skills_$(date +%Y%m%d_%H%M%S).log"
mkdir -p "${LOG_DIR}"

# Tee stdout to log, keep stderr going to terminal too
exec 3>&1
exec 1> >(tee -a "${LOG_FILE}") 2> >(tee -a "${LOG_FILE}" >&2)

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting import from ${SKILLS_DIR}"

# Absolute path for curl
SKILLS_DIR=$(cd "${SKILLS_DIR}" && pwd)

total=0
success=0
failed=0
for dir in "${SKILLS_DIR}"/*/; do
    [[ -d "${dir}" ]] || continue
    name=$(basename "${dir}")
    echo "[$(date '+%H:%M:%S')] Importing ${name}"
    http_code=$(curl -s -S -w "%{http_code}" -o /tmp/import_response.json \
        -X POST \
        -H "Content-Type: application/json" \
        -d "{\"path\":\"${dir%/}\"}" \
        "${BASE_URL}/api/skills/automation/import")
    if [[ "${http_code}" -lt 200 || "${http_code}" -ge 300 ]]; then
        echo "  FAILED (HTTP ${http_code}): $(cat /tmp/import_response.json)" >&2
        failed=$((failed + 1))
    else
        echo "  OK (HTTP ${http_code})"
        success=$((success + 1))
    fi
    total=$((total + 1))
done

echo
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Done: ${total} total, ${success} succeeded, ${failed} failed"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Log saved to ${LOG_FILE}" >&3
[[ "${total}" -gt 0 ]] || echo "Warning: no skill directories found in ${SKILLS_DIR}" >&2
exec 1>&3 3>&-
[[ "${failed}" -eq 0 ]] || exit 1
