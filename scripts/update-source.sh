#!/usr/bin/env bash
set -euo pipefail

DEFAULT_COMPOSE_FILE=/srv/agent-insight/compose.yml
RELEASES_DIR=${RELEASES_DIR:-/srv/agent-insight/releases}

usage() {
  cat <<'EOF'
Usage: bash update-source.sh --zip /path/to/source.zip [--compose /path/to/compose.yml]

--zip, -z       Source ZIP file (required; supports archives with wrapper directories)
--compose, -f   Compose file; edit DEFAULT_COMPOSE_FILE at the top to set the default
--help, -h      Show help

Requires bash, python3, and Docker Compose v2.
Compose must configure AGENT_INSIGHT_SOURCE_DIR=/src and ${SOURCE_RELEASE}:/src:ro.
Use the same Compose file and project name as the existing container; keep data mounts.
Back up the database and verify dependency and database compatibility before updating.
This script does not automatically back up or roll back the deployment.
EOF
}

fail() {
  printf 'Update failed: %s\n' "$1" >&2
  exit 1
}

COMPOSE_FILE_PATH=$DEFAULT_COMPOSE_FILE
ZIP_FILE=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --zip|-z)
      [ "$#" -ge 2 ] || fail '--zip requires a file path'
      ZIP_FILE=$2
      shift 2
      ;;
    --compose|-f)
      [ "$#" -ge 2 ] || fail '--compose requires a file path'
      COMPOSE_FILE_PATH=$2
      shift 2
      ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unsupported argument: $1" ;;
  esac
done

[ -n "$ZIP_FILE" ] || { usage >&2; fail 'Specify a source ZIP using --zip'; }
[ -f "$ZIP_FILE" ] || fail "ZIP file not found: $ZIP_FILE"
[ -f "$COMPOSE_FILE_PATH" ] || fail "Compose file not found: $COMPOSE_FILE_PATH"
for dependency in python3 docker; do
  command -v "$dependency" >/dev/null 2>&1 || fail "Required command not found: $dependency"
done
docker compose version >/dev/null || fail 'Docker Compose v2 is unavailable'

SOURCE_RELEASE=$(python3 - "$ZIP_FILE" "$RELEASES_DIR" <<'PY'
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import sys
import tempfile
import zipfile

try:
    with zipfile.ZipFile(sys.argv[1]) as archive:
        entries = archive.infolist()
        for entry in entries:
            relative = PurePosixPath(entry.filename)
            mode = entry.external_attr >> 16
            if relative.is_absolute() or '..' in relative.parts or '\\' in entry.filename:
                raise ValueError(f'ZIP contains an unsafe path: {entry.filename}')
            if stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR)):
                raise ValueError(f'ZIP contains an unsupported special file: {entry.filename}')
        releases = Path(sys.argv[2]).resolve()
        releases.mkdir(parents=True, exist_ok=True)
        destination = Path(tempfile.mkdtemp(prefix='release-', dir=releases))
        destination.chmod(0o755)
        for entry in entries:
            target = destination.joinpath(*PurePosixPath(entry.filename).parts)
            if entry.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(entry) as source, target.open('wb') as output:
                    shutil.copyfileobj(source, output)
                target.chmod(0o644 | ((entry.external_attr >> 16) & 0o111))
        for directory, _, _ in os.walk(destination):
            Path(directory).chmod(0o755)
        candidates = [package.parent for package in destination.rglob('package.json')
                      if (package.parent / 'prisma/schema.prisma').is_file()
                      and (package.parent / 'src').is_dir()]
        if len(candidates) != 1:
            raise ValueError(f'Expected exactly one source root, found {len(candidates)}; extracted files retained at {destination}')
        root = candidates[0]
        if json.loads((root / 'package.json').read_text()).get('name') != 'agent-insight':
            raise ValueError(f'Not an agent-insight source tree: {root}')
        print(root)
except (OSError, ValueError, RuntimeError, zipfile.BadZipFile) as error:
    print(f'Source ZIP validation or extraction failed: {error}', file=sys.stderr)
    sys.exit(1)
PY
) || fail 'Container was not updated; check the ZIP and extraction directory permissions'
export SOURCE_RELEASE

printf 'Compose: %s\nSource directory: %s\nRunning Compose update...\n' \
  "$COMPOSE_FILE_PATH" "$SOURCE_RELEASE"
if ! docker compose -f "$COMPOSE_FILE_PATH" up -d --force-recreate --pull never --no-build; then
  fail "Compose update failed; source retained at ${SOURCE_RELEASE}. Database rollback is not automatic"
fi
printf 'Compose command completed. The application may still be building.\nBefore running Compose separately, set:\nexport SOURCE_RELEASE=%q\n' "$SOURCE_RELEASE"
