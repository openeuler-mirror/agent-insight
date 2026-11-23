---
title: "Docker 镜像发布"
description: "介绍 Agent Insight 多架构 Docker 镜像的构建、发布验证及离线镜像包生成流程。"
keywords: ["Agent Insight", "Docker", "多架构镜像", "镜像发布", "离线部署"]
changefreq: monthly
---

<a id="docker-镜像发布"></a>
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

已启用源码挂载的离线部署可使用 `bash scripts/update-source.sh --zip <源码.zip>` 更新应用，使用方式见 [用户指南](../../tutorial/platform/01-quick-start.md)。脚本在宿主机解压并识别源码根目录，通过 `SOURCE_RELEASE` 为 Compose 提供源码路径，再按手动命令执行 `up -d --force-recreate --pull never --no-build`，不额外校验 Compose 挂载，也不等待健康检查。Compose 的源码挂载必须引用该变量；镜像依赖及已安装的 entrypoint 不变，数据库准备和 schema 同步仍由该入口执行。新源码必须兼容镜像依赖与现有数据库契约，脚本不自动备份或回滚数据库。

## 前置条件

以下前置条件适用于通用 npm 镜像；UBI9/OpenShift 源码镜像使用下节单独流程。

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

## 构建 UBI9/OpenShift 交付候选

`Dockerfile.openshift` 从当前源码及锁文件构建，构建和运行阶段使用同一 UBI9 Node.js 22 基础镜像。默认基础镜像固定到多架构 manifest digest；可通过 `UBI_NODE_IMAGE` 指向企业仓库的 UBI9 镜像或固定 digest。覆盖镜像必须提供 Node.js 22、npm 和完整 `dnf`，仅提供 `microdnf` 不满足此构建契约。系统包更新使用基础镜像配置的软件源，不从其他发行版复制原生依赖。

```bash
docker build --platform linux/amd64 \
  -f Dockerfile.openshift \
  --build-arg SOURCE_REVISION="$(git rev-parse HEAD)" \
  -t agent-insight:openshift-ubi9-test .

node scripts/verify-openshift-image.cjs agent-insight:openshift-ubi9-test
```

构建阶段执行 `npm ci`、生产编译及 `npm pack`；候选包含 Node.js 后端、Prisma、OpenCode 和现有运行依赖。首次支持范围为 SQLite 单副本；此镜像不提供 OpenGauss 运行时依赖。最终镜像保留 UID 0，目的是允许客户派生构建继承 root 身份执行完整 DNF 更新；实际部署必须由 OpenShift SCC 分配非 root UID，不能为此放宽 SCC 或增加特权。通用 `Dockerfile` 和 `Dockerfile.local` 的默认用户不变。

此候选使用构建时固化的源码，不支持通用镜像的 `AGENT_INSIGHT_SOURCE_DIR` 运行时源码挂载模式。代码升级需重新构建镜像；启动时仅重新生成包内 Prisma client，避免非 root UID 覆盖 root 属主文件时失败。

应用的 `python3` 使用 UBI AppStream 的 Python 3.11，以满足故障注入等模块的最低要求；DNF 继续使用系统自带的 Python。默认运行镜像禁用基础镜像附带的 CodeReady Builder 仓库，保留 UBI BaseOS/AppStream 更新源。企业镜像应配置其认可的软件源，并能提供 Python 3.11。

故障目录依赖的 PyYAML、RAS 依赖的 Pydantic 及其传递依赖由 `scripts/requirements-container.txt` 固定版本和 CPython 3.11 Linux wheel 的 SHA-256，构建时通过 pip 校验后安装。可用 `--build-arg PIP_INDEX_URL=<获准的Python包源>` 切换包源，校验和保持不变。容器验证同时检查 YAML 解析、故障目录、RAS 能力目录和思考循环检测器配置字段。DNF 更新的范围仍为 RPM，Python/npm 依赖需按各自的锁定来源重建和扫描。

客户派生补丁 Dockerfile 不需要 `USER`，例如：

```dockerfile
FROM <企业仓库中的本组件镜像及固定digest>
RUN dnf -y update && dnf clean all
```

在客户认可的软件源和构建环境中构建补丁镜像，分别记录原镜像和补丁镜像的 RPM 名称、版本、架构及来源。选择已有修复包的实际受影响组件核验更新结果；命令退出 0 或显示没有可更新包，均不能单独证明某项 CVE 已修复。两份镜像都应执行上述容器验证并重新扫描；npm 依赖和随程序携带的二进制漏洞需要分别处理。

npm 漏洞修复应更新源码中的依赖声明及锁文件，再用 `npm ci` 重建、扫描镜像。上层依赖限制了修复版本时，应同步升级兼容的上层版本；不要仅在已运行的容器里临时安装依赖并将其视为可复现的交付镜像。

验证脚本创建并清理自己的临时容器和 Docker 卷，在两个任意非 root UID、GID 0、删除全部 capabilities 和禁止权限提升的条件下验证 HTTP、HOME/XDG 写入、Prisma 原生引擎、OpenCode 服务启动、控制网关 WebSocket 握手、RAS 配置清单及重启持久化。脚本还以非法参数或无凭据请求校验模型连接、Trace 数据、基础设施探测与用量管理的关键 API，不调用真实模型。镜像通过共享入口启动 `scripts/control-server.js`，指令分发端口默认为应用端口加一且只绑定本机。它不连接模型，不替代业务评测、真实 SCC、PVC、Route、SSE/公网 WSS 或企业漏洞准入验收。发布前记录源码提交、构建文件校验和、基础镜像 digest、候选镜像 ID/仓库 digest、RPM 清单与验证结果。

`Dockerfile.openshift.dockerignore` 排除本地环境文件、私有配置、数据库和已有构建产物。不要在镜像或构建参数中加入客户密钥。若覆盖运行根目录，同时调整 `HOME` 和全部 `XDG_*_HOME` 到该目录下；数据卷权限由存储类型及 SCC/组权限配置共同决定，镜像层权限不会自动修复不匹配的已挂载卷。

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

### 升级后重算历史 OpenCode 耗时

先备份原数据卷，再在新容器中预览并应用 SQLite 历史耗时重算。镜像打包时已将命令编译，现场不需要下载开发依赖：

```bash
docker exec agent-insight node /app/node_modules/agent-insight/scripts/repair_trace_latency.cjs
docker exec agent-insight node /app/node_modules/agent-insight/scripts/repair_trace_latency.cjs --apply
```

容器名称按实际部署替换。该命令只更新有效执行耗时，可重复运行，保留原始 Trace、Token 和时间戳；缺失数据跳过，并发修改计入 `conflicts` 后可重跑。Compose 部署可使用 `docker compose exec -T agent-insight node /app/node_modules/agent-insight/scripts/repair_trace_latency.cjs`，确认后附加 `--apply`。
