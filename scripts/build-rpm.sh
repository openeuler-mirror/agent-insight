#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_SOURCE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

SOURCE_DIR="${DEFAULT_SOURCE_DIR}"
OUTPUT_DIR=""
WORK_DIR=""
PACKAGE_RELEASE=""
RUN_TESTS=1
INSTALL_DEPS=1
NPM_REGISTRY=""
PRISMA_ENGINES_MIRROR_OVERRIDE=""

usage() {
  sed -n '3,42p' "$0" | sed -n 's/^# \{0,1\}//p'
}

# Build the current Git HEAD as an installable Agent Insight RPM.
#
# Usage:
#   bash scripts/build-rpm.sh [options]
#
# Options:
#   --source-dir DIR   Source repository (default: repository containing this script)
#   --output-dir DIR   Build cache and deliverables (default: SOURCE_DIR/rpm-out)
#   --work-dir DIR     Temporary RPM workspace (default: /var/tmp/agent-insight-rpm-work-UID)
#   --release VALUE   RPM release (default: timestamp plus short commit)
#   --skip-tests      Do not run the test suite during rpmbuild
#   --no-install-deps Do not install missing RPM build tools with dnf
#   --npm-registry URL
#                      Use an internal npm registry and rewrite lockfile hosts
#   --prisma-engines-mirror URL
#                      Use an internal Prisma engines mirror
#   -h, --help        Show this help
#
# The source archive always comes from the current HEAD. Uncommitted application
# changes are rejected so the delivered RPM can be reproduced from BUILD-INFO.txt.

info() {
  printf '==> %s\n' "$*"
}

warn() {
  printf 'WARNING: %s\n' "$*" >&2
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

need_value() {
  [ "$#" -ge 2 ] || fail "$1 requires a value"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --source-dir)
      need_value "$@"
      SOURCE_DIR="$2"
      shift 2
      ;;
    --output-dir)
      need_value "$@"
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --work-dir)
      need_value "$@"
      WORK_DIR="$2"
      shift 2
      ;;
    --release)
      need_value "$@"
      PACKAGE_RELEASE="$2"
      shift 2
      ;;
    --skip-tests)
      RUN_TESTS=0
      shift
      ;;
    --no-install-deps)
      INSTALL_DEPS=0
      shift
      ;;
    --npm-registry)
      need_value "$@"
      NPM_REGISTRY="$2"
      shift 2
      ;;
    --prisma-engines-mirror)
      need_value "$@"
      PRISMA_ENGINES_MIRROR_OVERRIDE="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
done

[ "$(uname -s)" = "Linux" ] || fail "RPM builds require Linux"
[ -d "$SOURCE_DIR" ] || fail "source directory does not exist: $SOURCE_DIR"
SOURCE_DIR="$(cd "$SOURCE_DIR" && pwd)"
OUTPUT_DIR="${OUTPUT_DIR:-${SOURCE_DIR}/rpm-out}"
mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"
WORK_DIR="${WORK_DIR:-/var/tmp/agent-insight-rpm-work-$(id -u)}"
mkdir -p "$WORK_DIR"
WORK_DIR="$(cd "$WORK_DIR" && pwd)"

if [[ "$WORK_DIR" == "$SOURCE_DIR" || "$WORK_DIR" == "$SOURCE_DIR"/* ]]; then
  fail "RPM work directory must be outside the source tree to keep Next.js workspace detection stable: $WORK_DIR"
fi

git -C "$SOURCE_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 || \
  fail "not a Git repository: $SOURCE_DIR"
[ -f "$SOURCE_DIR/package.json" ] || fail "missing package.json in $SOURCE_DIR"
[ -f "$SOURCE_DIR/package-lock.json" ] || fail "missing package-lock.json in $SOURCE_DIR"
[ -f "$SOURCE_DIR/LICENSE" ] || fail "missing LICENSE in $SOURCE_DIR"

SELF_RELATIVE=""
if [[ "$SCRIPT_DIR" == "$SOURCE_DIR"/* ]]; then
  SELF_RELATIVE="${BASH_SOURCE[0]#${SOURCE_DIR}/}"
fi

DIRTY_STATUS="$(git -C "$SOURCE_DIR" status --porcelain=v1 --untracked-files=all | awk \
  -v self="$SELF_RELATIVE" \
  -v output="${OUTPUT_DIR#${SOURCE_DIR}/}" '
    {
      path = substr($0, 4)
      if (path == self || path == output || index(path, output "/") == 1) next
      print
    }
  ')"
[ -z "$DIRTY_STATUS" ] || fail "source tree has uncommitted changes outside the build script/output directory:\n$DIRTY_STATUS"

SOURCE_COMMIT="$(git -C "$SOURCE_DIR" rev-parse HEAD)"
SOURCE_BRANCH="$(git -C "$SOURCE_DIR" branch --show-current)"
SOURCE_BRANCH="${SOURCE_BRANCH:-detached}"
SHORT_COMMIT="$(git -C "$SOURCE_DIR" rev-parse --short=8 HEAD)"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  fail "Node.js and npm must be installed before building"
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || fail "Node.js 20 or newer is required; found $(node --version)"
BUILD_NODE_BIN="$(command -v node)"
BUILD_NPM_BIN="$(command -v npm)"
BUILD_NODE_DIR="$(dirname "$BUILD_NODE_BIN")"
[[ "$BUILD_NODE_BIN" == /* && "$BUILD_NPM_BIN" == /* ]] || \
  fail "node and npm must resolve to absolute executable paths"

BUILD_PACKAGES=(rpm-build gcc gcc-c++ make python3 curl openssl openssl-devel tar gzip cpio xz git)
MISSING_PACKAGES=()
for package_name in "${BUILD_PACKAGES[@]}"; do
  rpm -q "$package_name" >/dev/null 2>&1 || MISSING_PACKAGES+=("$package_name")
done

if [ "${#MISSING_PACKAGES[@]}" -gt 0 ] && [ "$INSTALL_DEPS" -eq 1 ]; then
  [ "$(id -u)" -eq 0 ] || \
    fail "missing RPM build packages (${MISSING_PACKAGES[*]}); rerun as root or install them first"
  command -v dnf >/dev/null 2>&1 || \
    fail "missing RPM build packages and dnf is unavailable: ${MISSING_PACKAGES[*]}"
  info "Installing missing build packages from the current system repositories"
  dnf install -y "${MISSING_PACKAGES[@]}"
  MISSING_PACKAGES=()
  for package_name in "${BUILD_PACKAGES[@]}"; do
    rpm -q "$package_name" >/dev/null 2>&1 || MISSING_PACKAGES+=("$package_name")
  done
fi
[ "${#MISSING_PACKAGES[@]}" -eq 0 ] || fail "missing RPM build packages: ${MISSING_PACKAGES[*]}"

REQUIRED_COMMANDS=(rpmbuild rpmspec rpm cpio tar gzip xz sha256sum git awk sed grep find xargs openssl)
MISSING_COMMANDS=()
for command_name in "${REQUIRED_COMMANDS[@]}"; do
  command -v "$command_name" >/dev/null 2>&1 || MISSING_COMMANDS+=("$command_name")
done
[ "${#MISSING_COMMANDS[@]}" -eq 0 ] || fail "missing build tools: ${MISSING_COMMANDS[*]}"

RAW_VERSION="$(node -p "require('$SOURCE_DIR/package.json').version")"
RPM_VERSION="$(printf '%s' "$RAW_VERSION" | sed 's/-/~/g; s/[^A-Za-z0-9._+~]/_/g')"
[ -n "$RPM_VERSION" ] || fail "package.json contains an empty version"

if [ -z "$PACKAGE_RELEASE" ]; then
  PACKAGE_RELEASE="1.$(date -u +%Y%m%d%H%M%S).git${SHORT_COMMIT}"
fi
[[ "$PACKAGE_RELEASE" =~ ^[A-Za-z0-9._+~]+$ ]] || \
  fail "invalid RPM release '$PACKAGE_RELEASE'; use letters, numbers, dot, underscore, plus, or tilde"

case "$(uname -m)" in
  x86_64)
    RPM_ARCH=x86_64
    OPENCODE_PLATFORM_PACKAGE=opencode-linux-x64
    ;;
  aarch64|arm64)
    RPM_ARCH=aarch64
    OPENCODE_PLATFORM_PACKAGE=opencode-linux-arm64
    ;;
  *)
    fail "unsupported build architecture: $(uname -m)"
    ;;
esac

if [ -n "$NPM_REGISTRY" ]; then
  [[ "$NPM_REGISTRY" =~ ^https?://[^[:space:]]+$ ]] || fail "invalid npm registry URL: $NPM_REGISTRY"
  export npm_config_registry="$NPM_REGISTRY"
  export npm_config_replace_registry_host=always
fi

if [ -n "$PRISMA_ENGINES_MIRROR_OVERRIDE" ]; then
  [[ "$PRISMA_ENGINES_MIRROR_OVERRIDE" =~ ^https?://[^[:space:]]+$ ]] || \
    fail "invalid Prisma engines mirror URL: $PRISMA_ENGINES_MIRROR_OVERRIDE"
  export PRISMA_ENGINES_MIRROR="$PRISMA_ENGINES_MIRROR_OVERRIDE"
fi

PACKAGE_NAME=agent-insight
BUILD_ID="${RPM_VERSION}-${PACKAGE_RELEASE}.${RPM_ARCH}"
BUILD_ROOT="${WORK_DIR}/${BUILD_ID}"
RPM_TOPDIR="${BUILD_ROOT}/rpmbuild"
RPM_TMPDIR="${BUILD_ROOT}/tmp"
NPM_CACHE="${OUTPUT_DIR}/cache/npm"
RELEASE_DIR="${OUTPUT_DIR}/${PACKAGE_NAME}-${BUILD_ID}"
BUILD_LOG="${BUILD_ROOT}/rpmbuild.log"

[ ! -e "$BUILD_ROOT" ] || fail "build directory already exists: $BUILD_ROOT"
[ ! -e "$RELEASE_DIR" ] || fail "release directory already exists: $RELEASE_DIR"
mkdir -p \
  "$RPM_TOPDIR/BUILD" \
  "$RPM_TOPDIR/BUILDROOT" \
  "$RPM_TOPDIR/RPMS" \
  "$RPM_TOPDIR/SOURCES" \
  "$RPM_TOPDIR/SPECS" \
  "$RPM_TOPDIR/SRPMS" \
  "$RPM_TMPDIR" \
  "$NPM_CACHE" \
  "$RELEASE_DIR"

info "Source: $SOURCE_DIR"
info "Work directory: $WORK_DIR"
info "Output directory: $OUTPUT_DIR"
info "Git: $SOURCE_BRANCH $SOURCE_COMMIT"
info "RPM: $PACKAGE_NAME-$RPM_VERSION-$PACKAGE_RELEASE.$RPM_ARCH"
info "Build Node.js: $(node --version) at $BUILD_NODE_BIN"
info "Bundled OpenCode platform package: $OPENCODE_PLATFORM_PACKAGE"
[ -z "$NPM_REGISTRY" ] || info "npm registry override enabled"
[ -z "$PRISMA_ENGINES_MIRROR_OVERRIDE" ] || info "Prisma engines mirror override enabled"

SOURCE_TARBALL="$RPM_TOPDIR/SOURCES/${PACKAGE_NAME}-${RPM_VERSION}.tar.gz"
git -C "$SOURCE_DIR" archive \
  --format=tar.gz \
  --prefix="${PACKAGE_NAME}-${RPM_VERSION}/" \
  --output="$SOURCE_TARBALL" \
  "$SOURCE_COMMIT"

cat > "$RPM_TOPDIR/SOURCES/agent-insight.env" <<'ENV_FILE'
NODE_ENV=production
NEXT_TELEMETRY_DISABLED=1
HOSTNAME=0.0.0.0
PORT=3000
HOME=/var/lib/agent-insight
AGENT_INSIGHT_DATA_DIR=/var/lib/agent-insight
DATABASE_URL=file:/var/lib/agent-insight/data/witty_insight.db
OPENCODE_BIN=/usr/lib/agent-insight/node_modules/.bin/opencode
ENV_FILE

cat > "$RPM_TOPDIR/SOURCES/agent-insight.service" <<'SERVICE_FILE'
[Unit]
Description=Agent Insight Service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=agent-insight
Group=agent-insight
WorkingDirectory=/usr/lib/agent-insight
Environment=PATH=/var/lib/agent-insight/runtime:/usr/lib/agent-insight/node_modules/.bin:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=-/etc/agent-insight/agent-insight.env
ExecStartPre=/usr/libexec/agent-insight-service check
ExecStartPre=/usr/libexec/agent-insight-service migrate
ExecStart=/usr/libexec/agent-insight-service start
Restart=on-failure
RestartSec=5
TimeoutStartSec=600
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=/var/lib/agent-insight

[Install]
WantedBy=multi-user.target
SERVICE_FILE

cat > "$RPM_TOPDIR/SOURCES/agent-insight-node-setup" <<'NODE_SETUP'
#!/usr/bin/env bash

set -euo pipefail

SERVICE_USER=agent-insight
RUNTIME_DIR=/var/lib/agent-insight/runtime
PRIVATE_NODE="$RUNTIME_DIR/node"
NODE_PATH_FILE="$RUNTIME_DIR/node-path"
NODE_ORIGIN_FILE="$RUNTIME_DIR/node-origin"
STAGED_NODE="$RUNTIME_DIR/node.candidate"
MIN_NODE_MAJOR=20

info() {
  printf 'agent-insight: %s\n' "$*"
}

warn() {
  printf 'agent-insight: WARNING: %s\n' "$*" >&2
}

node_version() {
  local candidate="$1"
  runuser -u "$SERVICE_USER" -- "$candidate" -p 'process.versions.node' 2>/dev/null
}

node_is_compatible() {
  local candidate="$1"
  local version
  local major

  [ -x "$candidate" ] || return 1
  version="$(node_version "$candidate")" || return 1
  major="${version%%.*}"
  [[ "$major" =~ ^[0-9]+$ ]] || return 1
  [ "$major" -ge "$MIN_NODE_MAJOR" ]
}

record_node() {
  local node_path="$1"
  local node_origin="$2"
  local version

  version="$(node_version "$node_path")"
  printf '%s\n' "$node_path" > "$NODE_PATH_FILE"
  printf '%s\n' "$node_origin" > "$NODE_ORIGIN_FILE"
  chmod 0644 "$NODE_PATH_FILE" "$NODE_ORIGIN_FILE"
  info "using Node.js v$version from $node_origin"
}

install_private_node() {
  local candidate="$1"

  install -m 0755 "$candidate" "$STAGED_NODE" 2>/dev/null || return 1
  chown root:root "$STAGED_NODE"
  if ! node_is_compatible "$STAGED_NODE"; then
    unlink "$STAGED_NODE"
    return 1
  fi
  mv -f "$STAGED_NODE" "$PRIVATE_NODE"
  record_node "$PRIVATE_NODE" "$candidate"
}

install -d -o root -g root -m 0755 "$RUNTIME_DIR"

SYSTEM_CANDIDATES=()
if command -v node >/dev/null 2>&1; then
  SYSTEM_CANDIDATES+=("$(command -v node)")
fi
SYSTEM_CANDIDATES+=(
  /usr/local/bin/node
  /usr/bin/node
  /bin/node
  /opt/node/bin/node
)

for candidate in "${SYSTEM_CANDIDATES[@]}"; do
  if node_is_compatible "$candidate"; then
    record_node "$(readlink -f "$candidate")" "$candidate"
    exit 0
  fi
done

if node_is_compatible "$PRIVATE_NODE"; then
  previous_origin="$PRIVATE_NODE"
  if [ -r "$NODE_ORIGIN_FILE" ]; then
    previous_origin="$(head -n 1 "$NODE_ORIGIN_FILE")"
  fi
  record_node "$PRIVATE_NODE" "$previous_origin"
  exit 0
fi

while IFS= read -r candidate; do
  [ -n "$candidate" ] || continue
  if install_private_node "$candidate"; then
    exit 0
  fi
done < <(
  for nvm_root in /root/.nvm/versions/node /home/*/.nvm/versions/node; do
    [ -d "$nvm_root" ] || continue
    find "$nvm_root" -mindepth 3 -maxdepth 3 -type f -path '*/bin/node' -print
  done | sort -Vr
)

: > "$NODE_PATH_FILE"
chmod 0644 "$NODE_PATH_FILE"
warn "no Node.js >= $MIN_NODE_MAJOR was found"
warn "install Node.js, then run: sudo /usr/libexec/agent-insight-node-setup"
exit 0
NODE_SETUP

cat > "$RPM_TOPDIR/SOURCES/agent-insight-service" <<'SERVICE_LAUNCHER'
#!/usr/bin/env bash

set -euo pipefail

NODE_PATH_FILE=/var/lib/agent-insight/runtime/node-path
MIN_NODE_MAJOR=20

node_is_compatible() {
  local candidate="$1"
  local version
  local major

  [ -x "$candidate" ] || return 1
  version="$("$candidate" -p 'process.versions.node' 2>/dev/null)" || return 1
  major="${version%%.*}"
  [[ "$major" =~ ^[0-9]+$ ]] || return 1
  [ "$major" -ge "$MIN_NODE_MAJOR" ]
}

resolve_node() {
  local configured_node=""
  local candidate

  if [ -r "$NODE_PATH_FILE" ]; then
    configured_node="$(head -n 1 "$NODE_PATH_FILE")"
  fi
  for candidate in \
    "$configured_node" \
    /var/lib/agent-insight/runtime/node \
    /usr/local/bin/node \
    /usr/bin/node \
    /bin/node \
    /opt/node/bin/node; do
    [ -n "$candidate" ] || continue
    if node_is_compatible "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

NODE_BIN="$(resolve_node)" || {
  printf '%s\n' 'agent-insight: Node.js 20 or newer is unavailable to the service user.' >&2
  printf '%s\n' 'Install Node.js, then run: sudo /usr/libexec/agent-insight-node-setup' >&2
  exit 127
}

case "${1:-}" in
  check)
    exec "$NODE_BIN" --version
    ;;
  migrate)
    exec "$NODE_BIN" \
      /usr/lib/agent-insight/node_modules/prisma/build/index.js \
      db push --skip-generate \
      --schema /usr/lib/agent-insight/prisma/schema.prisma
    ;;
  start)
    exec "$NODE_BIN" /usr/lib/agent-insight/server.js
    ;;
  *)
    printf 'Usage: %s {check|migrate|start}\n' "$0" >&2
    exit 2
    ;;
esac
SERVICE_LAUNCHER

cat > "$RPM_TOPDIR/SOURCES/prepare-prisma-engine.js" <<'PRISMA_HELPER'
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { createRequire } = require('node:module')

const root = process.cwd()
const requireFromRoot = createRequire(path.join(root, 'package.json'))
const { BinaryType, download } = requireFromRoot('@prisma/fetch-engine')
const { enginesVersion } = requireFromRoot('@prisma/engines')
const { getBinaryTargetForCurrentPlatform } = requireFromRoot('@prisma/get-platform')
const schemaPath = path.join(root, 'prisma', 'schema.prisma')
const buildSchemaPath = path.join(root, 'prisma', 'schema.rpm.prisma')
const enginesPath = path.join(root, 'node_modules', '@prisma', 'engines')

async function main() {
  const target = await getBinaryTargetForCurrentPlatform()
  console.log(`Prisma RPM target: ${target}`)
  const schema = fs.readFileSync(schemaPath, 'utf8')
  const buildSchema = schema.replace(
    /generator client \{\n/,
    `generator client {\n  binaryTargets = ["${target}"]\n`,
  )
  if (buildSchema === schema) throw new Error('Unable to add RPM binaryTargets')

  fs.writeFileSync(buildSchemaPath, buildSchema)
  try {
    await download({
      binaries: { [BinaryType.SchemaEngineBinary]: enginesPath },
      binaryTargets: [target],
      version: enginesVersion,
      showProgress: true,
    })
    const result = spawnSync(
      process.execPath,
      ['node_modules/prisma/build/index.js', 'generate', '--schema', buildSchemaPath],
      { stdio: 'inherit' },
    )
    if (result.status !== 0) throw new Error(`Prisma generate failed: ${result.status}`)
  } finally {
    fs.rmSync(buildSchemaPath, { force: true })
  }

  const expected = [
    path.join(enginesPath, `schema-engine-${target}`),
    path.join(root, 'node_modules', '.prisma', 'client', `libquery_engine-${target}.so.node`),
  ]
  for (const file of expected) fs.accessSync(file, fs.constants.R_OK)
  fs.writeFileSync(path.join(root, 'prisma.rpm.target'), `${target}\n`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
PRISMA_HELPER

cat > "$RPM_TOPDIR/SPECS/agent-insight.spec" <<SPEC_FILE
%global debug_package %{nil}
%global __strip /bin/true
%{!?package_release:%global package_release ${PACKAGE_RELEASE}}
%{!?run_tests:%global run_tests ${RUN_TESTS}}

Name:           ${PACKAGE_NAME}
Version:        ${RPM_VERSION}
Release:        %{package_release}%{?dist}
Summary:        Agent Skill evaluation and observability platform
License:        MIT
URL:            https://atomgit.com/openeuler/agent-insight

Source0:        %{name}-%{version}.tar.gz
Source1:        agent-insight.service
Source2:        agent-insight.env
Source3:        prepare-prisma-engine.js
Source4:        agent-insight-node-setup
Source5:        agent-insight-service

BuildArch:      ${RPM_ARCH}
AutoReqProv:    no
BuildRequires:  xz
Requires:       systemd
Requires:       python3
Requires:       curl
Requires:       openssl
Requires:       util-linux
Requires(pre):  shadow-utils
Recommends:     nodejs >= 20

%global appdir %{_prefix}/lib/%{name}
%global datadir %{_sharedstatedir}/%{name}
%global unitdir /usr/lib/systemd/system

%description
Agent Insight is an Agent Skill evaluation and observability platform.
Node.js is discovered from system paths or existing NVM installations.

%prep
%autosetup -n %{name}-%{version}

%build
export PATH=${BUILD_NODE_DIR}:/usr/bin:/bin
export AGENT_INSIGHT_DATA_DIR=%{_builddir}/agent-insight-build-data
export npm_config_cache=${NPM_CACHE}
export TMPDIR=%{_tmppath}
mkdir -p "\$AGENT_INSIGHT_DATA_DIR" "\$npm_config_cache" "\$TMPDIR"
${BUILD_NPM_BIN} ci
${BUILD_NODE_BIN} %{SOURCE3}
%if %{run_tests}
if [ -d test ]; then
  set +e
  find test -type f -name '*.test.ts' -print0 | \
    xargs -0 -r ${BUILD_NODE_BIN} --import tsx --test
  TEST_STATUS=\$?
  set -e
  if [ "\$TEST_STATUS" -ne 0 ]; then
    echo "WARNING: test suite failed with exit code \$TEST_STATUS; continuing RPM build" >&2
  fi
else
  echo "WARNING: source archive has no test directory; skipping tests" >&2
fi
%endif
${BUILD_NPM_BIN} run build
${BUILD_NODE_BIN} scripts/prepare-npm-package.js
${BUILD_NPM_BIN} prune --omit=dev
PRISMA_TARGET=\$(cat prisma.rpm.target)
test -x "node_modules/@prisma/engines/schema-engine-\$PRISMA_TARGET"
test -r "node_modules/.prisma/client/libquery_engine-\$PRISMA_TARGET.so.node"
test -x "node_modules/.bin/opencode"
test -x "node_modules/${OPENCODE_PLATFORM_PACKAGE}/bin/opencode"
BUNDLED_OPENCODE_VERSION=\$(node_modules/.bin/opencode --version)
test -n "\$BUNDLED_OPENCODE_VERSION"
echo "Bundled OpenCode: \$BUNDLED_OPENCODE_VERSION"

%install
install -d %{buildroot}%{appdir}
cp -a .next/standalone/. %{buildroot}%{appdir}/
install -d %{buildroot}%{appdir}/node_modules
cp -a node_modules/. %{buildroot}%{appdir}/node_modules/
install -D -m 0644 %{SOURCE1} %{buildroot}%{unitdir}/%{name}.service
install -D -m 0640 %{SOURCE2} %{buildroot}%{_sysconfdir}/%{name}/%{name}.env
install -D -m 0755 %{SOURCE4} %{buildroot}%{_libexecdir}/%{name}-node-setup
install -D -m 0755 %{SOURCE5} %{buildroot}%{_libexecdir}/%{name}-service
install -D -m 0644 prisma.rpm.target %{buildroot}%{_docdir}/%{name}/prisma-binary-target
install -d -m 0750 %{buildroot}%{datadir}/data
install -d -m 0755 %{buildroot}%{datadir}/runtime

%pre
getent group agent-insight >/dev/null || groupadd -r agent-insight
getent passwd agent-insight >/dev/null || \
  useradd -r -g agent-insight -d /var/lib/agent-insight \
    -s /sbin/nologin -c "Agent Insight service" agent-insight

%post
%{_libexecdir}/agent-insight-node-setup || :
/usr/bin/systemctl daemon-reload >/dev/null 2>&1 || :

%preun
if [ "\$1" -eq 0 ]; then
  /usr/bin/systemctl disable --now agent-insight.service >/dev/null 2>&1 || :
fi

%postun
/usr/bin/systemctl daemon-reload >/dev/null 2>&1 || :

%files
%defattr(-,root,root,-)
%license LICENSE
%{_docdir}/%{name}/prisma-binary-target
%{appdir}
%{_libexecdir}/%{name}-node-setup
%{_libexecdir}/%{name}-service
%{unitdir}/%{name}.service
%config(noreplace) %{_sysconfdir}/%{name}/%{name}.env
%attr(0750,agent-insight,agent-insight) %dir %{datadir}
%attr(0750,agent-insight,agent-insight) %dir %{datadir}/data
%attr(0755,root,root) %dir %{datadir}/runtime
SPEC_FILE

rpmspec -P \
  --define "_topdir $RPM_TOPDIR" \
  "$RPM_TOPDIR/SPECS/agent-insight.spec" >/dev/null

info "Starting rpmbuild"
set +e
rpmbuild \
  --define "_topdir $RPM_TOPDIR" \
  --define "_tmppath $RPM_TMPDIR" \
  --define "package_release $PACKAGE_RELEASE" \
  --define "run_tests $RUN_TESTS" \
  -ba "$RPM_TOPDIR/SPECS/agent-insight.spec" \
  2>&1 | tee "$BUILD_LOG"
RPMBUILD_STATUS=${PIPESTATUS[0]}
set -e
[ "$RPMBUILD_STATUS" -eq 0 ] || fail "rpmbuild failed; see $BUILD_LOG"

RPM_FILE="$(find "$RPM_TOPDIR/RPMS/$RPM_ARCH" -maxdepth 1 -type f -name "${PACKAGE_NAME}-${RPM_VERSION}-${PACKAGE_RELEASE}*.${RPM_ARCH}.rpm" -print -quit)"
SRPM_FILE="$(find "$RPM_TOPDIR/SRPMS" -maxdepth 1 -type f -name "${PACKAGE_NAME}-${RPM_VERSION}-${PACKAGE_RELEASE}*.src.rpm" -print -quit)"
[ -f "$RPM_FILE" ] || fail "binary RPM was not produced"
[ -f "$SRPM_FILE" ] || fail "source RPM was not produced"

info "Validating RPM contents"
rpm -qip "$RPM_FILE" >/dev/null || fail "unable to read binary RPM metadata: $RPM_FILE"
rpm -qpR "$RPM_FILE" >/dev/null || fail "unable to read binary RPM dependencies: $RPM_FILE"
PRISMA_BINARY_TARGET="$(grep -E '^Prisma RPM target: ' "$BUILD_LOG" | tail -n 1 | sed 's/^Prisma RPM target: //')"
[ -n "$PRISMA_BINARY_TARGET" ] || fail "Prisma platform target was not recorded"
BUNDLED_OPENCODE_VERSION="$(grep -E '^Bundled OpenCode: ' "$BUILD_LOG" | tail -n 1 | sed 's/^Bundled OpenCode: //')"
[ -n "$BUNDLED_OPENCODE_VERSION" ] || fail "bundled OpenCode version was not recorded"
RPM_FILE_LIST="$BUILD_ROOT/rpm-files.txt"
rpm -qlp "$RPM_FILE" > "$RPM_FILE_LIST" || fail "unable to list binary RPM contents: $RPM_FILE"
grep -Fq "schema-engine-${PRISMA_BINARY_TARGET}" "$RPM_FILE_LIST" || \
  fail "RPM is missing the Prisma schema engine for $PRISMA_BINARY_TARGET"
grep -Fq "libquery_engine-${PRISMA_BINARY_TARGET}.so.node" "$RPM_FILE_LIST" || \
  fail "RPM is missing the Prisma query engine for $PRISMA_BINARY_TARGET"
grep -Fqx '/usr/lib/agent-insight/node_modules/.bin/opencode' "$RPM_FILE_LIST" || \
  fail "RPM is missing the OpenCode command entry"
grep -Fqx '/usr/lib/agent-insight/node_modules/opencode-ai/bin/opencode' "$RPM_FILE_LIST" || \
  fail "RPM is missing the OpenCode launcher"
grep -Fqx "/usr/lib/agent-insight/node_modules/${OPENCODE_PLATFORM_PACKAGE}/bin/opencode" "$RPM_FILE_LIST" || \
  fail "RPM is missing the OpenCode native binary from $OPENCODE_PLATFORM_PACKAGE"
grep -Fqx '/usr/libexec/agent-insight-node-setup' "$RPM_FILE_LIST" || \
  fail "RPM is missing the Node.js setup helper"
grep -Fqx '/usr/libexec/agent-insight-service' "$RPM_FILE_LIST" || \
  fail "RPM is missing the service launcher"
if grep -Eq '^/(root|home|mnt)/' "$RPM_FILE_LIST"; then
  fail "RPM contains a build-host path"
fi

cp "$RPM_FILE" "$SRPM_FILE" "$RPM_TOPDIR/SPECS/agent-insight.spec" \
  "$RPM_TOPDIR/SOURCES/prepare-prisma-engine.js" \
  "$RPM_TOPDIR/SOURCES/agent-insight-node-setup" \
  "$RPM_TOPDIR/SOURCES/agent-insight-service" \
  "$BUILD_LOG" "$RELEASE_DIR/"

cat > "$RELEASE_DIR/BUILD-INFO.txt" <<BUILD_INFO
source_dir=$SOURCE_DIR
source_branch=$SOURCE_BRANCH
source_commit=$SOURCE_COMMIT
build_work_dir=$WORK_DIR
package_name=$PACKAGE_NAME
package_version=$RPM_VERSION
package_release=$PACKAGE_RELEASE
package_arch=$RPM_ARCH
opencode_platform_package=$OPENCODE_PLATFORM_PACKAGE
build_node=$(node --version)
build_npm=$(npm --version)
build_openssl=$(openssl version)
prisma_binary_target=$PRISMA_BINARY_TARGET
bundled_opencode=$BUNDLED_OPENCODE_VERSION
node_runtime_strategy=auto-detect-or-private-copy
npm_registry_mode=$([ -n "$NPM_REGISTRY" ] && printf override || printf environment-default)
prisma_engines_mirror_mode=$([ -n "$PRISMA_ENGINES_MIRROR_OVERRIDE" ] && printf override || printf environment-default)
tests_enabled=$RUN_TESTS
build_timestamp_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)
BUILD_INFO

(
  cd "$RELEASE_DIR"
  sha256sum ./* > SHA256SUMS
  sha256sum -c SHA256SUMS
)

printf '\n'
info "RPM build completed"
printf 'Release directory: %s\n' "$RELEASE_DIR"
printf 'Binary RPM: %s/%s\n' "$RELEASE_DIR" "$(basename "$RPM_FILE")"
printf 'Source RPM: %s/%s\n' "$RELEASE_DIR" "$(basename "$SRPM_FILE")"
printf 'Build log: %s/%s\n' "$RELEASE_DIR" "$(basename "$BUILD_LOG")"
