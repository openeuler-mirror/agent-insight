# Docker 镜像发布

本文面向维护者，说明如何基于已发布的 npm 包构建并发布 Docker 镜像。用户部署镜像时请看 README 或用户指南，不需要执行本文命令。

## 从本地源码构建测试镜像

频繁验证当前工作区时，不需要先发布 npm 包。使用 `Dockerfile.local` 会在 builder 阶段安装当前工作区依赖、执行 `npm run build` 和 `npm pack`，运行阶段复用 builder 的依赖、把本地 tgz 解包到标准 npm 包路径并执行同一个 `postinstall`，因此沿用与正式 npm 包相同的 `prepack`、`postinstall` 和 entrypoint 流程，同时避免为运行层重复下载依赖。这里刻意使用 `npm install`，让依赖调整期间尚未同步 lockfile 的本地工作区也能构建；正式发布前仍必须更新 `package-lock.json` 并确保 `npm ci` 通过。

```bash
docker build \
  -f Dockerfile.local \
  --build-arg LOCAL_BUILD_ID=2026-08-03 \
  -t agent-insight-local:2026-08-03 \
  .
```

`Dockerfile.local.dockerignore` 专门控制本地构建上下文；根目录 `.dockerignore` 仍只给正式 npm 版镜像传入 Dockerfile 和 entrypoint。构建时会包含当前工作区未提交的代码，但不会包含 `.git`、`node_modules`、数据库、测试数据和已有镜像包。

跨架构构建时显式指定服务器平台。例如，在 arm64 开发机上生成 amd64 测试镜像：

```bash
docker buildx build \
  --platform linux/amd64 \
  -f Dockerfile.local \
  --build-arg LOCAL_BUILD_ID=2026-08-03-amd64 \
  -t agent-insight-local:2026-08-03-amd64 \
  --load \
  .
```

本地镜像只用于测试和交付候选版本。正式发布仍使用根目录 `Dockerfile`，并从 npm 安装明确的 `AGENT_INSIGHT_VERSION`。

## 前置条件

- npm 上已经发布了目标版本，例如 `agent-insight@0.5.0`。
- 本机 Docker Desktop 或 Docker Engine 已启动。
- 已登录 Docker Hub，并且当前账号有 `karaggagent/agent-insight` 的推送权限。
- 需要发布多架构镜像时，`buildx` builder 可用。

```bash
docker login
docker buildx ls
```

如果没有可用 builder，可以创建一个：

```bash
docker buildx create --name agent-insight-builder --use
docker buildx inspect --bootstrap
```

## 发布多架构镜像

在仓库根目录执行。正式镜像使用根目录 `Dockerfile`，通过 `AGENT_INSIGHT_VERSION` 从 npm 拉取指定版本，不复制本地源码进镜像。

```bash
docker buildx build \
  --builder agent-insight-builder \
  --platform linux/amd64,linux/arm64 \
  --build-arg AGENT_INSIGHT_VERSION=0.5.0 \
  -t karaggagent/agent-insight:0.5.0 \
  -t karaggagent/agent-insight:latest \
  --push \
  .
```

如果不希望更新 `latest`，删除 `-t karaggagent/agent-insight:latest` 这一行。

## 验证发布结果

```bash
docker buildx imagetools inspect karaggagent/agent-insight:0.5.0
```

应看到至少两个平台：

```text
linux/amd64
linux/arm64
```

`unknown/unknown` 的 attestation manifest 是 buildx 生成的 provenance 元数据，不表示镜像架构错误。

## 生成离线镜像包

如果用户无法访问 Docker Hub，可以按目标服务器架构拉取并导出 `.tar`。

给 `x86_64` / `amd64` 服务器：

```bash
docker pull --platform linux/amd64 karaggagent/agent-insight:0.5.0
docker save karaggagent/agent-insight:0.5.0 -o agent-insight-0.5.0-amd64-image.tar
```

给 `aarch64` / `arm64` 服务器：

```bash
docker pull --platform linux/arm64 karaggagent/agent-insight:0.5.0
docker save karaggagent/agent-insight:0.5.0 -o agent-insight-0.5.0-arm64-image.tar
```

压缩后更适合传输：

```bash
gzip -9 agent-insight-0.5.0-amd64-image.tar
```

用户收到 `.tar` 或 `.tar.gz` 后，按 README 的离线导入流程部署。
