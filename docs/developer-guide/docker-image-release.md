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

## 客户分支的离线镜像交付

当前客户分支使用仓库根目录的 `compose.yaml`。交付方基于该分支的实际代码准备与客户服务器架构匹配的镜像，确保导入标签与 Compose 中的 `agent-insight:dev-jh` 一致；不能用默认 npm `latest` 镜像代替尚未发布的分支代码。离线包统一交付为 `agent-insight-image.tar.gz`，与 `compose.yaml` 放在同一目录。Compose 的 `pull_policy: never` 确保启动时只使用已导入的交付镜像。

需要使用编译产物交付时，先在目标 Linux 架构的隔离构建环境中执行 `npm ci`、`npm run build` 和 `npm pack`，运行镜像只复制产物及生产运行依赖。安装依赖前须复制仓库的 `.npmrc`，使锁文件与 `legacy-peer-deps` 设置保持一致；不能复制 macOS 的原生依赖到 Linux 镜像。平台包含采集与查询 API，因此需保留 `.next/standalone` 服务和 `.next/static`，不能仅用静态 Web 服务器承载。不要设置 `AGENT_INSIGHT_SOURCE_DIR`，以免启动时进入源码编译流程。

离线包还需包含当前 Qoder Desktop VSIX 和 JetBrains ZIP，放入 standalone 工作目录的 `.next/cache/qoder-plugins/`；同时保留 `integrations/`、`LICENSE` 和采集脚本供包版本校验。包缓存时间须晚于这些源文件，避免启动后的下载接口尝试现场编译或联网下载旧包。交付的 Compose 明确写入 `platform: linux/arm64` 时，只适用于对应架构。

用户首次执行 `docker load -i agent-insight-image.tar.gz`。已安装 Compose v2 时，填写 Compose 的 `AGENT_INSIGHT_INFERENCE_ANALYSIS_ORIGIN` 并执行 `docker compose up -d`；未安装 Compose 时，按[客户镜像部署指南](../user-guide/customer-image-deployment.md)执行 `docker run`，通过 `-e` 传入相同的分析地址，无需安装 Compose。两种方式均配置端口映射、自动重启、60 秒停止等待和日志轮转，数据库、配置和日志位于同一个 Docker 命名卷 `agent-insight-customer-data`，由镜像中 `/data/agent-insight` 的初始内容和用户权限初始化；不要添加 `nocopy` 或用宿主空目录挂载替代。固定卷名，避免更换交付目录后意外创建另一套空数据；不要同时启动两个实例使用该卷。不适用于直接接管原有 bind mount 部署，迁移已有数据需单独处理。

Docker entrypoint 对分析地址采用“容器环境显式值优先于运行目录 `.env`”的规则，包括显式空值；未设置容器变量时保留旧 `.env` 部署行为。环境变化需重建服务容器：Compose 使用 `docker compose up -d`，`docker run` 部署则停止并移除旧容器后，使用新环境变量及相同命名卷重新创建；仅 `restart` 不会更新环境变量。打包验收应覆盖空卷首次启动、普通用户可写、重建后 Trace 数据保留及修改分析地址后链接变化；当前 Compose 文件或启动命令本身不代表交付镜像已构建或完成这些验收。

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
