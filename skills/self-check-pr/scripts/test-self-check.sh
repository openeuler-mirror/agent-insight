#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/self-check-pr-test.XXXXXX")
trap 'rm -rf "$TMP_ROOT"' EXIT

REPO="$TMP_ROOT/repo"
FAKE_BIN="$TMP_ROOT/bin"
NPM_CALLS="$TMP_ROOT/npm-calls"
mkdir -p "$REPO" "$FAKE_BIN"

git -C "$REPO" init -q
git -C "$REPO" config user.email self-check@example.com
git -C "$REPO" config user.name self-check
printf 'base\n' > "$REPO/example.txt"
git -C "$REPO" add example.txt
git -C "$REPO" commit -qm base
git -C "$REPO" branch base
printf 'feature\n' >> "$REPO/example.txt"
git -C "$REPO" add example.txt
git -C "$REPO" commit -qm feature

cat > "$FAKE_BIN/npm" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$NPM_CALLS"
if [ "$*" = "run build" ]; then
  printf 'Failed to compile.\n' >&2
  exit 17
fi
exit 0
EOF
chmod +x "$FAKE_BIN/npm"

set +e
OUTPUT=$(cd "$REPO" && NPM_CALLS="$NPM_CALLS" PATH="$FAKE_BIN:$PATH" bash "$SCRIPT_DIR/self-check.sh" base 2>&1)
STATUS=$?
set -e

if [ "$STATUS" -eq 0 ]; then
  printf 'expected self-check to fail when npm run build fails\n%s\n' "$OUTPUT" >&2
  exit 1
fi
grep -qx 'run build' "$NPM_CALLS"
grep -q '生产构建失败' <<< "$OUTPUT"
