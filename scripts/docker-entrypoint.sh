#!/bin/sh
set -eu

: "${PORT:=3000}"
: "${HOSTNAME:=0.0.0.0}"
: "${AGENT_INSIGHT_DATA_DIR:=/data/agent-insight}"
: "${OPENCODE_BIN:=/app/node_modules/.bin/opencode}"
# 源码模式:指向挂载进来的源码目录。为空(默认)时完全走镜像里烤好的 agent-insight npm 包。
# 注意它必须由容器环境变量传入,这里读不到 $AGENT_INSIGHT_DATA_DIR/.env 里的配置。
: "${AGENT_INSIGHT_SOURCE_DIR:=}"

PACKAGE_ROOT="/app/node_modules/agent-insight"
SOURCE_WORKDIR="/app/source"
ENV_FILE="$AGENT_INSIGHT_DATA_DIR/.env"

# 把挂载进来的源码复制到容器内再构建:宿主机源码目录可以只读挂载,不会被写入 .next/node_modules,
# 也不用让宿主机目录属主匹配容器里的 node 用户。
prepare_source_workdir() {
  # 先把源码目录校验干净再动手,免得挂错路径时先把工作目录清了、再倒在后面的 prisma/build 上。
  if [ ! -f "$AGENT_INSIGHT_SOURCE_DIR/package.json" ]; then
    echo "Error: AGENT_INSIGHT_SOURCE_DIR=$AGENT_INSIGHT_SOURCE_DIR has no readable package.json." >&2
    echo "It must be the path inside the container (the mount target, not the host path), and readable by uid $(id -u)." >&2
    exit 1
  fi

  if [ ! -f "$AGENT_INSIGHT_SOURCE_DIR/prisma/schema.prisma" ]; then
    echo "Error: AGENT_INSIGHT_SOURCE_DIR=$AGENT_INSIGHT_SOURCE_DIR does not look like an agent-insight source tree (prisma/schema.prisma not found)." >&2
    exit 1
  fi

  if [ "$AGENT_INSIGHT_SOURCE_DIR" = "$SOURCE_WORKDIR" ]; then
    echo "Error: AGENT_INSIGHT_SOURCE_DIR must not be $SOURCE_WORKDIR — that path is the container's own build workdir and gets wiped on every start." >&2
    exit 1
  fi

  # 清掉上一轮的源码副本和构建产物,只留下 .next/cache——否则每次重启都是一次冷构建。
  # 这里清空目录内容而不是删目录本身:/app/source 可能被挂成 volume(用来跨容器重建保留缓存),
  # 对挂载点 rm -rf 会 EBUSY。
  mkdir -p "$SOURCE_WORKDIR"
  find "$SOURCE_WORKDIR" -mindepth 1 -maxdepth 1 ! -name .next -exec rm -rf {} +
  if [ -d "$SOURCE_WORKDIR/.next" ]; then
    find "$SOURCE_WORKDIR/.next" -mindepth 1 -maxdepth 1 ! -name cache -exec rm -rf {} +
  fi

  # node_modules/.next/.git 用镜像里和容器内构建的那份;其余几个都是 .gitignore 里的宿主机本地目录
  # (data/ 可以有上 G 的本地库,.claude/ 下还可能挂着 git worktree),复制进来纯属浪费。
  tar -C "$AGENT_INSIGHT_SOURCE_DIR" \
      --exclude=./node_modules \
      --exclude=./.next \
      --exclude=./.git \
      --exclude=./data \
      --exclude=./exclude \
      --exclude=./workspace \
      --exclude=./.claude \
      -cf - . | tar -C "$SOURCE_WORKDIR" -xf -

  if [ ! -f "$SOURCE_WORKDIR/package.json" ]; then
    echo "Error: failed to copy source from $AGENT_INSIGHT_SOURCE_DIR to $SOURCE_WORKDIR." >&2
    exit 1
  fi

  # 依赖统一用镜像预装的那份:软链同时让模块解析和 prisma 的 ../node_modules/.prisma 输出落到 /app/node_modules。
  ln -sfn /app/node_modules "$SOURCE_WORKDIR/node_modules"

  node -e '
    const fs = require("fs")
    const source = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
    const image = JSON.parse(fs.readFileSync("/app/node_modules/agent-insight/package.json", "utf8"))
    console.log(`Source mode: agent-insight ${source.version} from source (image dependencies: ${image.version})`)
    const required = Object.keys({ ...source.dependencies, ...source.devDependencies })
    const missing = required.filter((name) => !fs.existsSync(`/app/node_modules/${name}`))
    if (missing.length > 0) {
      console.warn(`Warning: ${missing.length} package(s) required by the source are missing from the image: ${missing.join(", ")}`)
      console.warn("Dependencies are baked into the image — rebuild the image after changing package.json.")
    }
  ' "$SOURCE_WORKDIR/package.json"
}

if [ -n "$AGENT_INSIGHT_SOURCE_DIR" ]; then
  echo "Source directory: $AGENT_INSIGHT_SOURCE_DIR"
  prepare_source_workdir
  PACKAGE_ROOT="$SOURCE_WORKDIR"
fi

mkdir -p "$AGENT_INSIGHT_DATA_DIR/data"

if [ ! -f "$ENV_FILE" ] && [ -f "$PACKAGE_ROOT/.env.example" ]; then
  cp "$PACKAGE_ROOT/.env.example" "$ENV_FILE"
fi

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

export PORT
export HOSTNAME
export AGENT_INSIGHT_DATA_DIR
export PATH="/app/node_modules/.bin:$PATH"

if [ -x "$OPENCODE_BIN" ]; then
  export OPENCODE_BIN
  echo "Using opencode binary: $OPENCODE_BIN"
else
  echo "Error: opencode binary not found at $OPENCODE_BIN" >&2
  exit 1
fi

case "${DATABASE_URL:-}" in
  ""|"file:../data/witty_insight.db")
    export DATABASE_URL="file:$AGENT_INSIGHT_DATA_DIR/data/witty_insight.db"
    ;;
esac

cd "$PACKAGE_ROOT"

if [ -n "${DB_HOST:-}" ]; then
  echo "Error: this Docker image is SQLite-first and does not include OpenGauss runtime dependencies." >&2
  echo "Unset DB_HOST (use SQLite), or build a dedicated OpenGauss-enabled image." >&2
  exit 1
else
  # 走 db_push.sh 而不是直接 npx：它对「整型列加宽 Int→BigInt」这一类无损变更放行，
  # 其余破坏性变更仍照旧拦下（本脚本 set -e，push 失败即中断启动）。
  # 详见 scripts/db_push.sh 顶部说明。
  sh scripts/db_push.sh
fi

npx prisma generate

if [ -n "$AGENT_INSIGHT_SOURCE_DIR" ]; then
  echo "Building from source (this can take a few minutes)..."
  npm run build

  # next build 按最近的 lockfile 推断 outputFileTracingRoot,依赖装在 /app 时它会选中 /app,
  # 于是 server.js 落在 .next/standalone/<源码目录名>/ 而不是 .next/standalone/。别写死路径。
  SOURCE_SERVER=$(find .next/standalone -maxdepth 2 -name server.js | head -n 1)
  if [ -z "$SOURCE_SERVER" ]; then
    echo "Error: next build produced no standalone server.js under $SOURCE_WORKDIR/.next/standalone." >&2
    exit 1
  fi
  SOURCE_STANDALONE=$(dirname "$SOURCE_SERVER")

  # 静态资源不在 standalone 产物里,得补进去(发布 npm 包时这步由 scripts/prepare-npm-package.js 做)。
  mkdir -p "$SOURCE_STANDALONE/.next/static" "$SOURCE_STANDALONE/public"
  cp -a .next/static/. "$SOURCE_STANDALONE/.next/static/"
  cp -a public/. "$SOURCE_STANDALONE/public/"

  exec node "$SOURCE_SERVER"
fi

exec node .next/standalone/server.js
