#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
exec node scripts/database-service.cjs clickhouse "$@"
