#!/usr/bin/env bash
set -euo pipefail

IMAGE=""
VOLUME="agent-insight-benchmark-evaluator-data"
RELEASE=""
ASSET_ROOT="/data/benchmark-assets/zsoft-l1"

fail() { printf 'ZSoft 资产镜像安装失败：%s\n' "$1" >&2; exit 1; }
usage() {
  cat <<'EOF'
Usage:
  bash scripts/benchmark/install-zsoft-assets-image.sh \
    --image REGISTRY/REPOSITORY@sha256:DIGEST \
    [--volume DOCKER_VOLUME] [--release RELEASE_ID]

The image is copied into the evaluator data volume at:
  /data/benchmark-assets/zsoft-l1/releases/<release-id>
The resulting evaluator setting is:
  ZSOFT_L1_ASSETS_DIR=/data/benchmark-assets/zsoft-l1/releases/<release-id>
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --image) [ "$#" -ge 2 ] || fail '--image 缺少参数'; IMAGE=$2; shift 2 ;;
    --volume) [ "$#" -ge 2 ] || fail '--volume 缺少参数'; VOLUME=$2; shift 2 ;;
    --release) [ "$#" -ge 2 ] || fail '--release 缺少参数'; RELEASE=$2; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) fail "不支持的参数：$1" ;;
  esac
done

[ -n "$IMAGE" ] || fail '必须指定 --image'
printf '%s' "$IMAGE" | LC_ALL=C grep -Eq '@sha256:[0-9a-f]{64}$' || fail '--image 必须使用固定 sha256 digest'
printf '%s' "$VOLUME" | LC_ALL=C grep -Eq '^[A-Za-z0-9][A-Za-z0-9_.-]*$' || fail 'Docker volume 名称无效'
[ -n "$RELEASE" ] || fail '必须指定 --release（应与镜像中的 releaseId 一致）'
printf '%s' "$RELEASE" | LC_ALL=C grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' || fail 'release id 无效'
command -v docker >/dev/null 2>&1 || fail '宿主缺少 docker'
docker info >/dev/null 2>&1 || fail 'Docker daemon 不可用'
docker volume inspect "$VOLUME" >/dev/null 2>&1 || fail "Docker volume 不存在：$VOLUME"

docker pull "$IMAGE" >/dev/null
CONTAINER="agent-insight-zsoft-assets-install-$$"
STAGING=$(mktemp -d "${TMPDIR:-/tmp}/zsoft-assets-install.XXXXXX")
LAYOUT=$(mktemp -d "${TMPDIR:-/tmp}/zsoft-assets-layout.XXXXXX")
cleanup() {
  docker rm "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$STAGING" "$LAYOUT"
}
trap cleanup EXIT

docker create --name "$CONTAINER" --mount "type=volume,src=$VOLUME,dst=/data" "$IMAGE" /bin/true >/dev/null
docker cp "$CONTAINER:/opt/agent-insight/zsoft-l1/$RELEASE/." "$STAGING/"

REPOSITORY_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
PYTHONPATH="$REPOSITORY_ROOT/benchmarks/zsoft-l1/evaluator" python3 - "$STAGING" "$RELEASE" <<'PY'
import json
import pathlib
import sys
from assets import load_inventory, verify_task

root = pathlib.Path(sys.argv[1])
release = sys.argv[2]
metadata = json.loads((root / "zsoft-release.json").read_text())
inventory = json.loads((root / "agent-insight-assets.json").read_text())
if metadata.get("schemaVersion") != "zsoft-release/v1" or metadata.get("releaseId") != release:
    raise SystemExit("资产镜像 release metadata 不匹配")
if metadata.get("assetSchema") != "zsoft-assets/v1" or metadata.get("bundleDigest") != inventory.get("bundleDigest"):
    raise SystemExit("资产镜像 bundleDigest 不匹配")
checked = load_inventory(root)
for task_id in checked["tasks"]:
    verify_task(root, checked, task_id)
PY

TARGET="$ASSET_ROOT/releases/$RELEASE"
PROBE=$(mktemp -d "${TMPDIR:-/tmp}/zsoft-assets-probe.XXXXXX")
if docker cp "$CONTAINER:$TARGET" "$PROBE/" >/dev/null 2>&1; then
  rm -rf "$PROBE"
  fail "目标 release 已存在，拒绝覆盖：$TARGET"
fi
rm -rf "$PROBE"

mkdir -p "$LAYOUT/benchmark-assets/zsoft-l1/releases/$RELEASE"
cp -a "$STAGING/." "$LAYOUT/benchmark-assets/zsoft-l1/releases/$RELEASE/"
docker cp "$LAYOUT/benchmark-assets" "$CONTAINER:/data/"

printf '已安装 ZSoft 资产 release：%s\n' "$RELEASE"
printf '评测配置：ZSOFT_L1_ASSETS_DIR=%s\n' "$TARGET"
