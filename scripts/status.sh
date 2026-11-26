#!/bin/bash
cd "$(dirname "$0")/.." || exit 1
exec node scripts/project-storage.cjs status "$@"
