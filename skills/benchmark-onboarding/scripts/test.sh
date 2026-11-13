#!/usr/bin/env bash
set -euo pipefail
skill_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
for script in "$skill_dir"/scripts/*.cjs; do
  node --check "$script"
done
node --test "$skill_dir/tests/onboarding.test.cjs"
